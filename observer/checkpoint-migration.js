import { clampStep, projectIgnitionEvidence } from './checkpoint-migration-model.mjs';

const DEFAULT_EVIDENCE_URL = '../evidence/ignition-v0.23-retained-checkpoint-migration.json';
let model = null;
let activeStep = 0;

const els = {
  status: document.querySelector('#load-status'),
  source: document.querySelector('#source-line'),
  bytesDelta: document.querySelector('#bytes-delta'),
  workDelta: document.querySelector('#work-delta'),
  residency: document.querySelector('#residency'),
  replay: document.querySelector('#replay'),
  steps: document.querySelector('#steps'),
  stepTitle: document.querySelector('#step-title'),
  stepMeta: document.querySelector('#step-meta'),
  domainFlow: document.querySelector('#domain-flow'),
  buildBar: document.querySelector('#build-bar'),
  retainedBar: document.querySelector('#retained-bar'),
  meterValue: document.querySelector('#meter-value'),
  previous: document.querySelector('#previous-step'),
  next: document.querySelector('#next-step'),
  finalHash: document.querySelector('#final-hash'),
  finalDomains: document.querySelector('#final-domains'),
  safeClaim: document.querySelector('#safe-claim'),
  notClaimed: document.querySelector('#not-claimed'),
  file: document.querySelector('#evidence-file'),
  reload: document.querySelector('#reload-evidence'),
};

function formatBytes(value) {
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000} KB`;
  return `${new Intl.NumberFormat().format(value)} B`;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value);
}

function setStatus(text, tone = 'neutral') {
  els.status.textContent = text;
  els.status.dataset.tone = tone;
}

function chip(label, state) {
  const span = document.createElement('span');
  span.className = `chip chip-${state}`;
  span.textContent = label;
  return span;
}

function renderStep(index, announce = true) {
  if (!model) return;
  activeStep = clampStep(index, model.steps.length);
  const step = model.steps[activeStep];
  els.stepTitle.textContent = `Step ${step.step} · ${step.transition}`;
  els.stepMeta.textContent = `Inspecting migration ${activeStep + 1} of ${model.steps.length}`;
  els.domainFlow.replaceChildren();

  const groups = [
    ['Built', step.addedDomains, 'built'],
    ['Reused', step.retainedDomains, 'retained'],
    ['Evicted', step.evictedDomains, 'evicted'],
  ];
  groups.forEach(([label, values, state]) => {
    const group = document.createElement('div');
    group.className = 'flow-group';
    const heading = document.createElement('strong');
    heading.textContent = label;
    group.append(heading);
    const row = document.createElement('div');
    row.className = 'chip-row';
    if (values.length === 0) row.append(chip('none', 'quiet'));
    values.forEach((value) => row.append(chip(value, state)));
    group.append(row);
    els.domainFlow.append(group);
  });

  els.buildBar.style.width = `${step.buildRatio * 100}%`;
  els.retainedBar.style.width = `${step.retainedRatio * 100}%`;
  els.meterValue.textContent = `${formatBytes(step.residentBytes)} / ${formatBytes(model.headline.maxResidentBytes)} current-set ceiling`;
  els.steps.querySelectorAll('button').forEach((button, buttonIndex) => {
    button.setAttribute('aria-current', buttonIndex === activeStep ? 'step' : 'false');
    button.dataset.active = buttonIndex === activeStep ? 'true' : 'false';
  });
  els.previous.disabled = activeStep === 0;
  els.next.disabled = activeStep === model.steps.length - 1;
  if (announce) setStatus(`Step ${step.step}: ${step.transition}`, 'ready');
}

function renderModel(nextModel, sourceLabel) {
  model = nextModel;
  activeStep = 0;
  els.source.textContent = sourceLabel;
  els.bytesDelta.textContent = `${formatBytes(model.headline.bytesBefore)} → ${formatBytes(model.headline.bytesAfter)} · ${model.headline.bytesReductionPercent}% less construction`;
  els.workDelta.textContent = `${formatNumber(model.headline.workBefore)} → ${formatNumber(model.headline.workAfter)} · ${model.headline.workReductionPercent}% less build work`;
  els.residency.textContent = `${formatBytes(model.headline.maxResidentBytes)} maximum · ${formatBytes(model.headline.finalResidentBytes)} final`;
  els.replay.textContent = model.headline.exactReplayPreserved && model.headline.ceilingPreserved ? 'Preserved · exact replay + residency ceiling' : 'Evidence does not assert both preservation gates';
  els.replay.dataset.pass = model.headline.exactReplayPreserved && model.headline.ceilingPreserved ? 'true' : 'false';

  els.steps.replaceChildren();
  model.steps.forEach((step, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'step-tab';
    button.innerHTML = `<span>${index + 1}</span><b>step ${step.step}</b><small>${step.selectedDomains.join(' + ')}</small>`;
    button.addEventListener('click', () => renderStep(index));
    els.steps.append(button);
  });

  els.finalHash.textContent = model.final.hash || 'not recorded';
  els.finalDomains.textContent = model.final.selectedDomains.join(', ') || 'none';
  els.safeClaim.textContent = model.truth.strongestSafeClaim;
  els.notClaimed.replaceChildren(...model.truth.notClaimed.map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));
  renderStep(0, false);
  setStatus(`Evidence ready · ${model.steps.length} migrations`, 'ready');
}

async function loadReceipt(receipt, sourceLabel) {
  try {
    renderModel(projectIgnitionEvidence(receipt), sourceLabel);
  } catch (error) {
    model = null;
    setStatus(`Held · ${error.message}`, 'error');
  }
}

async function loadDefault() {
  setStatus('Loading sealed v0.23 evidence…');
  try {
    const response = await fetch(DEFAULT_EVIDENCE_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await loadReceipt(await response.json(), 'Bundled sealed v0.23 evidence · read-only projection');
  } catch (error) {
    setStatus(`Could not load bundled evidence · ${error.message}. Serve the repository over localhost or choose the JSON file below.`, 'error');
  }
}

els.previous.addEventListener('click', () => renderStep(activeStep - 1));
els.next.addEventListener('click', () => renderStep(activeStep + 1));
els.reload.addEventListener('click', loadDefault);
els.file.addEventListener('change', async () => {
  const [file] = els.file.files;
  if (!file) return;
  setStatus(`Reading ${file.name}…`);
  try {
    await loadReceipt(JSON.parse(await file.text()), `Local file · ${file.name} · read-only projection`);
  } catch (error) {
    setStatus(`Held · ${error.message}`, 'error');
  }
});

document.addEventListener('keydown', (event) => {
  if (!model || event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
  if (event.key === 'ArrowRight' || event.key === 'PageDown') {
    event.preventDefault();
    renderStep(activeStep + 1);
  } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
    event.preventDefault();
    renderStep(activeStep - 1);
  } else if (event.key === 'Home') {
    event.preventDefault();
    renderStep(0);
  } else if (event.key === 'End') {
    event.preventDefault();
    renderStep(model.steps.length - 1);
  }
});

loadDefault();
