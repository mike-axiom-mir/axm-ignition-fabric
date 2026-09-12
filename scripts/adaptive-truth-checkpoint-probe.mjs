import { AdaptiveTruthCheckpointGovernor, replaceDomainCheckpointSelection } from "../src/adaptive-truth-checkpoint-governor.js";
import {
  applyDomainCheckpointedWorkspacePointPatch,
  bootstrapDomainCheckpointedWorkspaceTruth,
} from "../src/domain-checkpointed-workspace-truth.js";
import { REALISTIC_DOMAINS } from "../src/realistic-mutations.js";
import { buildWorkspaceState } from "../src/realistic-workload.js";

const policy = process.argv[2] || "adaptive";
const scenario = process.argv[3] || "frequency-vs-position";
const policies = ["none", "frequency", "oracle", "adaptive", "all-seven"];
const scenarios = ["frequency-vs-position", "phase-shift"];
if (!policies.includes(policy)) throw new Error(`unknown v0.23 policy: ${policy}`);
if (!scenarios.includes(scenario)) throw new Error(`unknown v0.23 scenario: ${scenario}`);

const fileCount = 2500;
const checkpointBudgetBytes = 20_000;
const valueWindow = 4;
const initialState = buildWorkspaceState({ fileCount, packageCount: 25 });

function pathPatch(state, fileId, suffix) {
  const file = state.files.find((entry) => entry.id === fileId);
  if (!file) throw new Error(`missing file: ${fileId}`);
  return { path: `${file.path}${suffix}` };
}

function importPatch(state, fileId, fromTarget, toTarget) {
  const file = state.files.find((entry) => entry.id === fileId);
  if (!file) throw new Error(`missing file: ${fileId}`);
  const needle = `file-${fromTarget}.js`;
  const replacement = `file-${toTarget}.js`;
  if (needle.length !== replacement.length) throw new Error("v0.23 import toggle must be same width");
  if (!file.content.includes(needle)) throw new Error(`file ${fileId} missing ${needle}`);
  return { content: file.content.replace(needle, replacement) };
}

function operationsForScenario(name) {
  if (name === "frequency-vs-position") {
    return [
      ...Array.from({ length: 6 }, (_, i) => ({ kind: "path", fileId: 0, suffix: `-freq-early-${i}`, phase: "early-metadata" })),
      { kind: "import", fileId: 2499, from: 0, to: 1, phase: "late-import" },
      { kind: "import", fileId: 2499, from: 1, to: 0, phase: "late-import" },
      { kind: "import", fileId: 2499, from: 0, to: 1, phase: "late-import" },
      { kind: "import", fileId: 2499, from: 1, to: 0, phase: "late-import" },
    ];
  }
  return [
    { kind: "import", fileId: 2499, from: 0, to: 1, phase: "late-import" },
    { kind: "import", fileId: 2499, from: 1, to: 0, phase: "late-import" },
    { kind: "import", fileId: 2499, from: 0, to: 1, phase: "late-import" },
    { kind: "import", fileId: 2499, from: 1, to: 0, phase: "late-import" },
    ...Array.from({ length: 5 }, (_, i) => ({ kind: "path", fileId: 2499, suffix: `-phase-late-${i}`, phase: "late-metadata" })),
  ];
}

function identityVector(tracked) {
  return Object.fromEntries(Object.entries(tracked.domainIndex.identity.domains).map(([domain, entry]) => [domain, {
    hash: entry.hash,
    revision: entry.revision,
  }]));
}

function makePatch(state, operation) {
  if (operation.kind === "path") return pathPatch(state, operation.fileId, operation.suffix);
  return importPatch(state, operation.fileId, operation.from, operation.to);
}

function staticInitialDomains(name) {
  if (name === "none") return [];
  if (name === "frequency") return ["content-hash", "metadata"];
  if (name === "all-seven") return REALISTIC_DOMAINS;
  if (name === "oracle") return ["content-hash", "imports"];
  return [];
}

function oracleDomainsForOperation(operation) {
  return operation.phase === "late-metadata" ? ["metadata"] : ["content-hash", "imports"];
}

function mergePeak(current, value) {
  return Math.max(current, value);
}

const operations = operationsForScenario(scenario);
let tracked;
let totalDomainCanonicalCharactersRehashed = 0;
let totalDomainEntriesRehashed = 0;
let totalDomainEntriesSkipped = 0;
let totalStateFingerprintCharactersRehashed = 0;
let checkpointBuildCanonicalCharacters = 0;
let checkpointBytesBuilt = 0;
let checkpointBytesEvicted = 0;
let checkpointBytesRetainedAcrossMigrations = 0;
let reconfigurationCount = 0;
let maxPersistentDomainCheckpointBytes = 0;
const selectionTimeline = [];
let governor = null;

function chargeMigration(metrics) {
  checkpointBuildCanonicalCharacters += metrics.buildCanonicalCharacters;
  checkpointBytesBuilt += metrics.bytesBuilt;
  checkpointBytesEvicted += metrics.bytesEvicted;
  checkpointBytesRetainedAcrossMigrations += metrics.bytesRetained;
  reconfigurationCount += 1;
}

if (policy === "adaptive") {
  governor = new AdaptiveTruthCheckpointGovernor({
    state: initialState,
    maxCheckpointBytes: checkpointBudgetBytes,
    valueWindow,
  });
  tracked = governor.tracked;
} else {
  tracked = bootstrapDomainCheckpointedWorkspaceTruth(initialState, { checkpointDomains: [] });
}

const started = performance.now();

if (policy !== "adaptive") {
  const initialDomains = staticInitialDomains(policy);
  if (initialDomains.length) {
    const replacement = replaceDomainCheckpointSelection(tracked, initialDomains);
    tracked = replacement.tracked;
    chargeMigration(replacement.metrics);
    maxPersistentDomainCheckpointBytes = mergePeak(maxPersistentDomainCheckpointBytes, tracked.domainHashCheckpoints.checkpointBytes);
    selectionTimeline.push({ step: 0, reason: "initial-policy-selection", domains: [...tracked.domainHashCheckpoints.selectedDomains] });
  }
}

for (let i = 0; i < operations.length; i += 1) {
  const operation = operations[i];
  if (policy === "oracle") {
    const desired = oracleDomainsForOperation(operation);
    const current = [...tracked.domainHashCheckpoints.selectedDomains];
    if (JSON.stringify(current) !== JSON.stringify(desired)) {
      const replacement = replaceDomainCheckpointSelection(tracked, desired);
      tracked = replacement.tracked;
      chargeMigration(replacement.metrics);
      selectionTimeline.push({ step: i + 1, reason: "oracle-phase-selection", domains: [...desired] });
    }
  }

  const patch = makePatch(policy === "adaptive" ? governor.tracked.state : tracked.state, operation);
  if (policy === "adaptive") {
    const outcome = governor.applyPointPatch({
      fileId: operation.fileId,
      patch,
      evidence: { benchmark: "v0.23", policy, scenario, step: i + 1, phase: operation.phase },
    });
    tracked = outcome.tracked;
    if (JSON.stringify(outcome.decision.selectedBefore) !== JSON.stringify(outcome.decision.selectedAfter)) {
      selectionTimeline.push({
        step: i + 1,
        reason: "adaptive-decision",
        domains: [...outcome.decision.selectedAfter],
        changedDomains: [...outcome.decision.changedDomains],
      });
    }
  } else {
    tracked = applyDomainCheckpointedWorkspacePointPatch({
      tracked,
      fileId: operation.fileId,
      patch,
      evidence: { benchmark: "v0.23", policy, scenario, step: i + 1, phase: operation.phase },
    });
  }

  const mutation = tracked.lastMutation;
  totalDomainCanonicalCharactersRehashed += mutation.domainAdvance.totalDomainCanonicalCharactersRehashed;
  totalDomainEntriesRehashed += mutation.domainAdvance.totalDomainEntriesRehashed;
  totalDomainEntriesSkipped += mutation.domainAdvance.totalDomainEntriesSkipped;
  totalStateFingerprintCharactersRehashed += mutation.fingerprintAdvance.canonicalCharactersRehashed;
  maxPersistentDomainCheckpointBytes = mergePeak(maxPersistentDomainCheckpointBytes, tracked.domainHashCheckpoints.checkpointBytes);
}

const wallMs = performance.now() - started;

if (policy === "adaptive") {
  const summary = governor.summary();
  checkpointBuildCanonicalCharacters = summary.totalCheckpointBuildCanonicalCharacters;
  checkpointBytesBuilt = summary.totalCheckpointBytesBuilt;
  checkpointBytesEvicted = summary.totalCheckpointBytesEvicted;
  checkpointBytesRetainedAcrossMigrations = summary.totalCheckpointBytesRetainedAcrossMigrations;
  reconfigurationCount = summary.reconfigurationCount;
  maxPersistentDomainCheckpointBytes = Math.max(maxPersistentDomainCheckpointBytes, summary.persistentCheckpointBytes);
}

const finalDomainCheckpointBytes = tracked.domainHashCheckpoints.checkpointBytes;
const chargedDomainCanonicalWork = totalDomainCanonicalCharactersRehashed + checkpointBuildCanonicalCharacters;

console.log(JSON.stringify({
  schema: "axm.ignition-adaptive-truth-checkpoint-probe/v0.23",
  policy,
  scenario,
  fileCount,
  operationCount: operations.length,
  checkpointBudgetBytes,
  valueWindow,
  wallMs,
  finalHash: tracked.stateHash,
  finalCanonicalCharacters: tracked.canonicalSizeHint.canonicalCharacters,
  finalDomainIdentity: identityVector(tracked),
  finalSelectedDomains: [...tracked.domainHashCheckpoints.selectedDomains],
  finalDomainCheckpointBytes,
  maxPersistentDomainCheckpointBytes,
  totalDomainCanonicalCharactersRehashed,
  totalDomainEntriesRehashed,
  totalDomainEntriesSkipped,
  totalStateFingerprintCharactersRehashed,
  checkpointBuildCanonicalCharacters,
  checkpointBytesBuilt,
  checkpointBytesEvicted,
  checkpointBytesRetainedAcrossMigrations,
  reconfigurationCount,
  chargedDomainCanonicalWork,
  selectionTimeline,
  adaptiveStats: policy === "adaptive" ? governor.summary().stats : null,
  overBudgetReference: policy === "all-seven",
  timingBoundary: "Fresh Node process. Shared initial v0.20/no-domain-checkpoint workspace bootstrap is excluded. Timed region includes admitted checkpoint construction, retained-record migration, eviction, and all point-mutation truth advances. Independent external verification is performed by the aggregate benchmark, not inside this probe.",
  residencyBoundary: "The checkpoint byte ceiling applies to the exact records retained by the current checkpoint set. Physical transient allocator peak during a migration is not measured by this probe.",
}));
