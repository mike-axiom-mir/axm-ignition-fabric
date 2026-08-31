import { canonicalStringCharacterLength } from "./canonical-size-hint.js";
import { buildWorkspaceDomainHashCheckpoints } from "./checkpointed-domain-hashes.js";
import {
  applyDomainCheckpointedWorkspacePointPatch,
  bootstrapDomainCheckpointedWorkspaceTruth,
  DOMAIN_CHECKPOINTED_WORKSPACE_TRUTH_SCHEMA,
} from "./domain-checkpointed-workspace-truth.js";
import { REALISTIC_DOMAINS } from "./realistic-mutations.js";

export const ADAPTIVE_TRUTH_CHECKPOINT_GOVERNOR_SCHEMA = "axm.ignition-adaptive-truth-checkpoint-governor/v0.22";

function normalizeBudget(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("checkpoint budget must be a non-negative integer");
  return value;
}

function normalizeWindow(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("checkpoint value window must be a positive integer");
  return value;
}

function sameDomains(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function normalizeDomains(domains) {
  const unique = [...new Set(domains || [])];
  for (const domain of unique) {
    if (!REALISTIC_DOMAINS.includes(domain)) throw new Error(`unknown checkpoint domain: ${domain}`);
  }
  return REALISTIC_DOMAINS.filter((domain) => unique.includes(domain));
}

function buildCostCharacters(tracked, domains) {
  return normalizeDomains(domains).reduce((sum, domain) => sum + canonicalStringCharacterLength({
    domain,
    fileCount: tracked.domainIndex.fileCount,
    entries: tracked.domainIndex.entriesByDomain[domain],
  }), 0);
}

export function replaceDomainCheckpointSelection(tracked, checkpointDomains) {
  if (!tracked || tracked.schema !== DOMAIN_CHECKPOINTED_WORKSPACE_TRUTH_SCHEMA) {
    throw new Error("checkpoint selection replacement requires domain-checkpointed workspace truth");
  }
  const selectedDomains = normalizeDomains(checkpointDomains);
  const beforeDomains = [...tracked.domainHashCheckpoints.selectedDomains];
  const beforeBytes = tracked.domainHashCheckpoints.checkpointBytes;
  const buildCanonicalCharacters = buildCostCharacters(tracked, selectedDomains);
  const domainHashCheckpoints = buildWorkspaceDomainHashCheckpoints(tracked.domainIndex, { domains: selectedDomains });
  if (domainHashCheckpoints.stateHash !== tracked.stateHash) throw new Error("replacement checkpoint set changed state truth");

  const afterBytes = domainHashCheckpoints.checkpointBytes;
  const addedDomains = selectedDomains.filter((domain) => !beforeDomains.includes(domain));
  const evictedDomains = beforeDomains.filter((domain) => !selectedDomains.includes(domain));
  const retainedDomains = selectedDomains.filter((domain) => beforeDomains.includes(domain));
  const nextTracked = Object.freeze({ ...tracked, domainHashCheckpoints });
  return Object.freeze({
    tracked: nextTracked,
    metrics: Object.freeze({
      mode: "checkpoint-selection-rebuild",
      beforeDomains: Object.freeze(beforeDomains),
      afterDomains: Object.freeze([...selectedDomains]),
      addedDomains: Object.freeze(addedDomains),
      evictedDomains: Object.freeze(evictedDomains),
      retainedDomains: Object.freeze(retainedDomains),
      beforeBytes,
      afterBytes,
      bytesBuilt: afterBytes,
      bytesEvicted: Math.max(0, beforeBytes - retainedDomains.length * tracked.domainIndex.fileCount * 4),
      buildCanonicalCharacters,
      rebuildsRetainedDomains: retainedDomains.length > 0,
    }),
  });
}

function makeStats(windowSize) {
  return Object.fromEntries(REALISTIC_DOMAINS.map((domain) => [domain, {
    domain,
    mutationCount: 0,
    lastFullCanonicalCharacters: null,
    recentOpportunityCharacters: Array(windowSize).fill(0),
    totalOpportunityCharacters: 0,
    totalActualCharactersSaved: 0,
    checkpointHitCount: 0,
    fallbackCount: 0,
    buildCount: 0,
    buildCanonicalCharactersCharged: 0,
    checkpointBytesBuilt: 0,
    checkpointBytesEvicted: 0,
  }]));
}

function freezeStats(stats) {
  return Object.freeze(Object.fromEntries(REALISTIC_DOMAINS.map((domain) => {
    const value = stats[domain];
    return [domain, Object.freeze({
      ...value,
      recentOpportunityCharacters: Object.freeze([...value.recentOpportunityCharacters]),
      recentOpportunityTotal: value.recentOpportunityCharacters.reduce((sum, item) => sum + item, 0),
    })];
  })));
}

export class AdaptiveTruthCheckpointGovernor {
  #stats;
  #decisionHistory;

  constructor({ state, maxCheckpointBytes = 20_000, valueWindow = 4 } = {}) {
    if (!state || !Array.isArray(state.files)) throw new Error("adaptive checkpoint governor requires workspace state");
    this.schema = ADAPTIVE_TRUTH_CHECKPOINT_GOVERNOR_SCHEMA;
    this.maxCheckpointBytes = normalizeBudget(maxCheckpointBytes);
    this.valueWindow = normalizeWindow(valueWindow);
    this.bytesPerDomain = state.files.length * 4;
    this.maxDomains = this.bytesPerDomain === 0 ? 0 : Math.floor(this.maxCheckpointBytes / this.bytesPerDomain);
    this.tracked = bootstrapDomainCheckpointedWorkspaceTruth(state, { checkpointDomains: [] });
    this.generation = 0;
    this.totalDomainCanonicalCharactersRehashed = 0;
    this.totalCheckpointBuildCanonicalCharacters = 0;
    this.totalCheckpointBytesBuilt = 0;
    this.totalCheckpointBytesEvicted = 0;
    this.reconfigurationCount = 0;
    this.#stats = makeStats(this.valueWindow);
    this.#decisionHistory = [];
  }

  #advanceWindow() {
    for (const domain of REALISTIC_DOMAINS) {
      const window = this.#stats[domain].recentOpportunityCharacters;
      window.push(0);
      while (window.length > this.valueWindow) window.shift();
    }
  }

  #observeMutation(tracked) {
    const mutation = tracked.lastMutation;
    const fileIndex = mutation.fileIndex;
    const fileCount = tracked.domainIndex.fileCount;
    const changed = mutation.mutationReceipt.changedDomains;
    this.#advanceWindow();
    this.totalDomainCanonicalCharactersRehashed += mutation.domainAdvance.totalDomainCanonicalCharactersRehashed;

    for (const domain of changed) {
      const stat = this.#stats[domain];
      const metric = mutation.domainAdvance.metricsByDomain[domain];
      stat.mutationCount += 1;
      if (metric.mode === "full-domain-rehash-no-checkpoint") {
        stat.lastFullCanonicalCharacters = metric.canonicalCharactersRehashed;
        stat.fallbackCount += 1;
      } else {
        stat.checkpointHitCount += 1;
      }
      const full = stat.lastFullCanonicalCharacters;
      if (!Number.isSafeInteger(full) || full < 0) {
        throw new Error(`adaptive checkpoint governor lacks observed full replay cost: ${domain}`);
      }
      const opportunity = metric.mode === "checkpointed-domain-suffix-rehash"
        ? Math.max(0, full - metric.canonicalCharactersRehashed)
        : fileCount <= 1
          ? 0
          : Math.floor(full * fileIndex / (fileCount - 1));
      stat.recentOpportunityCharacters[stat.recentOpportunityCharacters.length - 1] = opportunity;
      stat.totalOpportunityCharacters += opportunity;
      if (metric.mode === "checkpointed-domain-suffix-rehash") stat.totalActualCharactersSaved += opportunity;
    }
  }

  #rankSelection() {
    const current = new Set(this.tracked.domainHashCheckpoints.selectedDomains);
    const candidates = [];
    for (const domain of REALISTIC_DOMAINS) {
      const stat = this.#stats[domain];
      const recent = stat.recentOpportunityCharacters.reduce((sum, value) => sum + value, 0);
      const full = stat.lastFullCanonicalCharacters;
      if (!Number.isSafeInteger(full) || full <= 0 || recent <= 0 || this.bytesPerDomain <= 0) continue;
      const admissionCost = current.has(domain) ? 0 : full;
      const net = recent - admissionCost;
      if (net <= 0) continue;
      candidates.push({
        domain,
        recentOpportunityCharacters: recent,
        admissionCostCharacters: admissionCost,
        netReplayValueCharacters: net,
        valuePerCheckpointByte: net / this.bytesPerDomain,
        currentlySelected: current.has(domain),
      });
    }
    candidates.sort((a, b) => (
      b.valuePerCheckpointByte - a.valuePerCheckpointByte
      || b.netReplayValueCharacters - a.netReplayValueCharacters
      || REALISTIC_DOMAINS.indexOf(a.domain) - REALISTIC_DOMAINS.indexOf(b.domain)
    ));
    const selected = normalizeDomains(candidates.slice(0, this.maxDomains).map((entry) => entry.domain));
    return { selected, candidates };
  }

  #chargeReconfiguration(metrics) {
    this.reconfigurationCount += 1;
    this.totalCheckpointBuildCanonicalCharacters += metrics.buildCanonicalCharacters;
    this.totalCheckpointBytesBuilt += metrics.bytesBuilt;
    this.totalCheckpointBytesEvicted += metrics.bytesEvicted;
    for (const domain of metrics.afterDomains) {
      const stat = this.#stats[domain];
      stat.buildCount += 1;
      const currentCost = canonicalStringCharacterLength({
        domain,
        fileCount: this.tracked.domainIndex.fileCount,
        entries: this.tracked.domainIndex.entriesByDomain[domain],
      });
      stat.buildCanonicalCharactersCharged += currentCost;
      stat.checkpointBytesBuilt += this.bytesPerDomain;
    }
    for (const domain of metrics.evictedDomains) this.#stats[domain].checkpointBytesEvicted += this.bytesPerDomain;
  }

  applyPointPatch({ fileId, patch, evidence = {} }) {
    const selectedBefore = [...this.tracked.domainHashCheckpoints.selectedDomains];
    let tracked = applyDomainCheckpointedWorkspacePointPatch({
      tracked: this.tracked,
      fileId,
      patch,
      evidence: {
        ...structuredClone(evidence),
        checkpointGovernorSchema: this.schema,
        checkpointBudgetBytes: this.maxCheckpointBytes,
        checkpointDomainsBefore: selectedBefore,
      },
    });
    this.#observeMutation(tracked);
    this.tracked = tracked;

    const ranked = this.#rankSelection();
    let reconfiguration = null;
    if (!sameDomains(selectedBefore, ranked.selected)) {
      const replacement = replaceDomainCheckpointSelection(this.tracked, ranked.selected);
      this.#chargeReconfiguration(replacement.metrics);
      tracked = replacement.tracked;
      this.tracked = tracked;
      reconfiguration = replacement.metrics;
    }
    if (this.tracked.domainHashCheckpoints.checkpointBytes > this.maxCheckpointBytes) {
      throw new Error("adaptive checkpoint governor exceeded hard checkpoint budget");
    }

    this.generation += 1;
    const decision = Object.freeze({
      schema: "axm.ignition-adaptive-truth-checkpoint-decision/v0.22",
      generation: this.generation,
      fileIndex: tracked.lastMutation.fileIndex,
      changedDomains: Object.freeze([...tracked.lastMutation.mutationReceipt.changedDomains]),
      selectedBefore: Object.freeze(selectedBefore),
      selectedAfter: Object.freeze([...this.tracked.domainHashCheckpoints.selectedDomains]),
      persistentCheckpointBytes: this.tracked.domainHashCheckpoints.checkpointBytes,
      maxCheckpointBytes: this.maxCheckpointBytes,
      totalDomainCanonicalCharactersRehashed: tracked.lastMutation.domainAdvance.totalDomainCanonicalCharactersRehashed,
      domainEntriesSkipped: tracked.lastMutation.domainAdvance.totalDomainEntriesSkipped,
      rankedCandidates: Object.freeze(ranked.candidates.map((entry) => Object.freeze({ ...entry }))),
      reconfiguration,
    });
    this.#decisionHistory.push(decision);
    return Object.freeze({ tracked: this.tracked, decision });
  }

  stats() {
    return freezeStats(this.#stats);
  }

  decisions() {
    return Object.freeze([...this.#decisionHistory]);
  }

  summary() {
    return Object.freeze({
      schema: this.schema,
      generation: this.generation,
      maxCheckpointBytes: this.maxCheckpointBytes,
      bytesPerDomain: this.bytesPerDomain,
      maxDomains: this.maxDomains,
      selectedDomains: Object.freeze([...this.tracked.domainHashCheckpoints.selectedDomains]),
      persistentCheckpointBytes: this.tracked.domainHashCheckpoints.checkpointBytes,
      totalDomainCanonicalCharactersRehashed: this.totalDomainCanonicalCharactersRehashed,
      totalCheckpointBuildCanonicalCharacters: this.totalCheckpointBuildCanonicalCharacters,
      totalCheckpointBytesBuilt: this.totalCheckpointBytesBuilt,
      totalCheckpointBytesEvicted: this.totalCheckpointBytesEvicted,
      reconfigurationCount: this.reconfigurationCount,
      stats: this.stats(),
    });
  }
}
