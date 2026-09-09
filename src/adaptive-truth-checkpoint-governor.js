import { createHash } from "node:crypto";

import { stableStringify } from "./canonical-fingerprint-primitives.js";
import { migrateWorkspaceDomainHashCheckpointSelection } from "./checkpointed-domain-hashes.js";
import {
  applyDomainCheckpointedWorkspacePointPatch,
  bootstrapDomainCheckpointedWorkspaceTruth,
  DOMAIN_CHECKPOINTED_WORKSPACE_TRUTH_SCHEMA,
} from "./domain-checkpointed-workspace-truth.js";
import { REALISTIC_DOMAINS } from "./realistic-mutations.js";

export const ADAPTIVE_TRUTH_CHECKPOINT_GOVERNOR_SCHEMA = "axm.ignition-adaptive-truth-checkpoint-governor/v0.23";
export const ADAPTIVE_TRUTH_CHECKPOINT_CONTINUATION_SCHEMA = "axm.ignition-adaptive-truth-checkpoint-continuation/v1";

const CONTINUATION_COUNTER_FIELDS = Object.freeze([
  "generation",
  "totalDomainCanonicalCharactersRehashed",
  "totalCheckpointBuildCanonicalCharacters",
  "totalCheckpointBytesBuilt",
  "totalCheckpointBytesEvicted",
  "totalCheckpointBytesRetainedAcrossMigrations",
  "reconfigurationCount",
]);

const STAT_COUNTER_FIELDS = Object.freeze([
  "mutationCount",
  "totalOpportunityCharacters",
  "totalActualCharactersSaved",
  "checkpointHitCount",
  "fallbackCount",
  "buildCount",
  "buildCanonicalCharactersCharged",
  "checkpointBytesBuilt",
  "checkpointBytesEvicted",
  "checkpointBytesRetainedAcrossMigrations",
]);

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

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}

function continuationDigest(payload) {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function cloneStatsForContinuation(stats) {
  return Object.fromEntries(REALISTIC_DOMAINS.map((domain) => {
    const value = stats[domain];
    return [domain, {
      domain,
      mutationCount: value.mutationCount,
      lastFullCanonicalCharacters: value.lastFullCanonicalCharacters,
      recentOpportunityCharacters: [...value.recentOpportunityCharacters],
      totalOpportunityCharacters: value.totalOpportunityCharacters,
      totalActualCharactersSaved: value.totalActualCharactersSaved,
      checkpointHitCount: value.checkpointHitCount,
      fallbackCount: value.fallbackCount,
      buildCount: value.buildCount,
      buildCanonicalCharactersCharged: value.buildCanonicalCharactersCharged,
      checkpointBytesBuilt: value.checkpointBytesBuilt,
      checkpointBytesEvicted: value.checkpointBytesEvicted,
      checkpointBytesRetainedAcrossMigrations: value.checkpointBytesRetainedAcrossMigrations,
    }];
  }));
}

function freezeContinuationStats(stats) {
  return Object.freeze(Object.fromEntries(REALISTIC_DOMAINS.map((domain) => [
    domain,
    Object.freeze({
      ...stats[domain],
      recentOpportunityCharacters: Object.freeze([...stats[domain].recentOpportunityCharacters]),
    }),
  ])));
}

function validateContinuationStats(stats, valueWindow) {
  assertPlainObject(stats, "adaptive continuation stats");
  const keys = Object.keys(stats).sort();
  const expectedKeys = [...REALISTIC_DOMAINS].sort();
  if (!sameDomains(keys, expectedKeys)) throw new Error("adaptive continuation stats must contain exactly the known domains");

  const normalized = {};
  for (const domain of REALISTIC_DOMAINS) {
    const value = stats[domain];
    assertPlainObject(value, `adaptive continuation stat ${domain}`);
    if (value.domain !== domain) throw new Error(`adaptive continuation stat domain mismatch: ${domain}`);
    if (!Array.isArray(value.recentOpportunityCharacters) || value.recentOpportunityCharacters.length !== valueWindow) {
      throw new Error(`adaptive continuation recent window mismatch: ${domain}`);
    }
    for (const [index, item] of value.recentOpportunityCharacters.entries()) {
      assertNonNegativeInteger(item, `adaptive continuation recent opportunity ${domain}[${index}]`);
    }
    if (value.lastFullCanonicalCharacters !== null) {
      assertNonNegativeInteger(value.lastFullCanonicalCharacters, `adaptive continuation last full replay ${domain}`);
    }
    for (const field of STAT_COUNTER_FIELDS) {
      assertNonNegativeInteger(value[field], `adaptive continuation ${domain}.${field}`);
    }
    normalized[domain] = {
      domain,
      mutationCount: value.mutationCount,
      lastFullCanonicalCharacters: value.lastFullCanonicalCharacters,
      recentOpportunityCharacters: [...value.recentOpportunityCharacters],
      totalOpportunityCharacters: value.totalOpportunityCharacters,
      totalActualCharactersSaved: value.totalActualCharactersSaved,
      checkpointHitCount: value.checkpointHitCount,
      fallbackCount: value.fallbackCount,
      buildCount: value.buildCount,
      buildCanonicalCharactersCharged: value.buildCanonicalCharactersCharged,
      checkpointBytesBuilt: value.checkpointBytesBuilt,
      checkpointBytesEvicted: value.checkpointBytesEvicted,
      checkpointBytesRetainedAcrossMigrations: value.checkpointBytesRetainedAcrossMigrations,
    };
  }
  return normalized;
}

function validateContinuationEnvelope(continuation) {
  assertPlainObject(continuation, "adaptive checkpoint continuation");
  if (continuation.schema !== ADAPTIVE_TRUTH_CHECKPOINT_CONTINUATION_SCHEMA) {
    throw new Error("unsupported adaptive checkpoint continuation schema");
  }
  if (continuation.governorSchema !== ADAPTIVE_TRUTH_CHECKPOINT_GOVERNOR_SCHEMA) {
    throw new Error("adaptive checkpoint continuation governor schema mismatch");
  }
  if (typeof continuation.continuationSha256 !== "string" || !/^[0-9a-f]{64}$/.test(continuation.continuationSha256)) {
    throw new Error("adaptive checkpoint continuation requires SHA-256 identity");
  }

  const { continuationSha256, ...payload } = continuation;
  if (continuationDigest(payload) !== continuationSha256) {
    throw new Error("adaptive checkpoint continuation SHA-256 mismatch");
  }

  if (typeof payload.stateHash !== "string" || !payload.stateHash) {
    throw new Error("adaptive checkpoint continuation requires stateHash");
  }
  assertNonNegativeInteger(payload.canonicalCharacters, "adaptive checkpoint continuation canonicalCharacters");
  const maxCheckpointBytes = normalizeBudget(payload.maxCheckpointBytes);
  const valueWindow = normalizeWindow(payload.valueWindow);
  assertNonNegativeInteger(payload.bytesPerDomain, "adaptive checkpoint continuation bytesPerDomain");
  assertNonNegativeInteger(payload.maxDomains, "adaptive checkpoint continuation maxDomains");
  for (const field of CONTINUATION_COUNTER_FIELDS) {
    assertNonNegativeInteger(payload[field], `adaptive checkpoint continuation ${field}`);
  }

  if (!Array.isArray(payload.selectedDomains)) throw new Error("adaptive checkpoint continuation selectedDomains must be an array");
  const selectedDomains = normalizeDomains(payload.selectedDomains);
  if (!sameDomains(selectedDomains, payload.selectedDomains) || new Set(payload.selectedDomains).size !== payload.selectedDomains.length) {
    throw new Error("adaptive checkpoint continuation selectedDomains must be canonical, sorted and unique");
  }
  const expectedMaxDomains = payload.bytesPerDomain === 0 ? 0 : Math.floor(maxCheckpointBytes / payload.bytesPerDomain);
  if (payload.maxDomains !== expectedMaxDomains) throw new Error("adaptive checkpoint continuation maxDomains mismatch");
  if (selectedDomains.length > payload.maxDomains) throw new Error("adaptive checkpoint continuation exceeds checkpoint-domain budget");
  if (selectedDomains.length * payload.bytesPerDomain > maxCheckpointBytes) {
    throw new Error("adaptive checkpoint continuation exceeds checkpoint byte budget");
  }

  return {
    ...payload,
    maxCheckpointBytes,
    valueWindow,
    selectedDomains,
    stats: validateContinuationStats(payload.stats, valueWindow),
  };
}

export function replaceDomainCheckpointSelection(tracked, checkpointDomains) {
  if (!tracked || tracked.schema !== DOMAIN_CHECKPOINTED_WORKSPACE_TRUTH_SCHEMA) {
    throw new Error("checkpoint selection replacement requires domain-checkpointed workspace truth");
  }
  const selectedDomains = normalizeDomains(checkpointDomains);
  const migration = migrateWorkspaceDomainHashCheckpointSelection(
    tracked.domainIndex,
    tracked.domainHashCheckpoints,
    { domains: selectedDomains },
  );
  if (migration.checkpointSet.stateHash !== tracked.stateHash) {
    throw new Error("migrated checkpoint set changed state truth");
  }

  const nextTracked = Object.freeze({ ...tracked, domainHashCheckpoints: migration.checkpointSet });
  return Object.freeze({
    tracked: nextTracked,
    metrics: migration.metrics,
  });
}

export const migrateDomainCheckpointSelection = replaceDomainCheckpointSelection;

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
    checkpointBytesRetainedAcrossMigrations: 0,
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
  #resumeReceipt;

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
    this.totalCheckpointBytesRetainedAcrossMigrations = 0;
    this.reconfigurationCount = 0;
    this.#stats = makeStats(this.valueWindow);
    this.#decisionHistory = [];
    this.#resumeReceipt = null;
  }

  static restore({ state, continuation } = {}) {
    if (!state || !Array.isArray(state.files)) throw new Error("adaptive checkpoint restore requires workspace state");
    const payload = validateContinuationEnvelope(continuation);
    const governor = new AdaptiveTruthCheckpointGovernor({
      state,
      maxCheckpointBytes: payload.maxCheckpointBytes,
      valueWindow: payload.valueWindow,
    });

    if (governor.tracked.stateHash !== payload.stateHash) {
      throw new Error("adaptive checkpoint continuation does not match canonical state");
    }
    if (governor.tracked.canonicalSizeHint.canonicalCharacters !== payload.canonicalCharacters) {
      throw new Error("adaptive checkpoint continuation canonical size mismatch");
    }
    if (governor.bytesPerDomain !== payload.bytesPerDomain || governor.maxDomains !== payload.maxDomains) {
      throw new Error("adaptive checkpoint continuation workspace shape mismatch");
    }

    const restoredSelection = replaceDomainCheckpointSelection(governor.tracked, payload.selectedDomains);
    governor.tracked = restoredSelection.tracked;
    governor.generation = payload.generation;
    governor.totalDomainCanonicalCharactersRehashed = payload.totalDomainCanonicalCharactersRehashed;
    governor.totalCheckpointBuildCanonicalCharacters = payload.totalCheckpointBuildCanonicalCharacters;
    governor.totalCheckpointBytesBuilt = payload.totalCheckpointBytesBuilt;
    governor.totalCheckpointBytesEvicted = payload.totalCheckpointBytesEvicted;
    governor.totalCheckpointBytesRetainedAcrossMigrations = payload.totalCheckpointBytesRetainedAcrossMigrations;
    governor.reconfigurationCount = payload.reconfigurationCount;
    governor.#stats = payload.stats;
    governor.#decisionHistory = [];

    governor.totalCheckpointBuildCanonicalCharacters += restoredSelection.metrics.buildCanonicalCharacters;
    governor.totalCheckpointBytesBuilt += restoredSelection.metrics.bytesBuilt;
    for (const domain of restoredSelection.metrics.addedDomains) {
      const currentCost = restoredSelection.metrics.buildCanonicalCharactersByDomain[domain];
      if (!Number.isSafeInteger(currentCost) || currentCost < 0) {
        throw new Error(`missing checkpoint restore build cost for domain: ${domain}`);
      }
      const stat = governor.#stats[domain];
      stat.buildCount += 1;
      stat.buildCanonicalCharactersCharged += currentCost;
      stat.checkpointBytesBuilt += governor.bytesPerDomain;
    }

    governor.#resumeReceipt = Object.freeze({
      schema: "axm.ignition-adaptive-truth-checkpoint-resume/v1",
      continuationSha256: continuation.continuationSha256,
      generation: governor.generation,
      stateHash: governor.tracked.stateHash,
      selectedDomains: Object.freeze([...governor.tracked.domainHashCheckpoints.selectedDomains]),
      checkpointBytesRebuilt: restoredSelection.metrics.bytesBuilt,
      checkpointBuildCanonicalCharacters: restoredSelection.metrics.buildCanonicalCharacters,
      priorDecisionHistoryRetained: false,
    });
    return governor;
  }

  checkpoint() {
    const payload = {
      schema: ADAPTIVE_TRUTH_CHECKPOINT_CONTINUATION_SCHEMA,
      governorSchema: this.schema,
      stateHash: this.tracked.stateHash,
      canonicalCharacters: this.tracked.canonicalSizeHint.canonicalCharacters,
      maxCheckpointBytes: this.maxCheckpointBytes,
      valueWindow: this.valueWindow,
      bytesPerDomain: this.bytesPerDomain,
      maxDomains: this.maxDomains,
      generation: this.generation,
      selectedDomains: [...this.tracked.domainHashCheckpoints.selectedDomains],
      totalDomainCanonicalCharactersRehashed: this.totalDomainCanonicalCharactersRehashed,
      totalCheckpointBuildCanonicalCharacters: this.totalCheckpointBuildCanonicalCharacters,
      totalCheckpointBytesBuilt: this.totalCheckpointBytesBuilt,
      totalCheckpointBytesEvicted: this.totalCheckpointBytesEvicted,
      totalCheckpointBytesRetainedAcrossMigrations: this.totalCheckpointBytesRetainedAcrossMigrations,
      reconfigurationCount: this.reconfigurationCount,
      stats: cloneStatsForContinuation(this.#stats),
    };
    return Object.freeze({
      ...payload,
      selectedDomains: Object.freeze([...payload.selectedDomains]),
      stats: freezeContinuationStats(payload.stats),
      continuationSha256: continuationDigest(payload),
    });
  }

  resumeReceipt() {
    return this.#resumeReceipt;
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
    this.totalCheckpointBytesRetainedAcrossMigrations += metrics.bytesRetained;

    for (const domain of metrics.addedDomains) {
      const stat = this.#stats[domain];
      const currentCost = metrics.buildCanonicalCharactersByDomain[domain];
      if (!Number.isSafeInteger(currentCost) || currentCost < 0) {
        throw new Error(`missing checkpoint build cost for admitted domain: ${domain}`);
      }
      stat.buildCount += 1;
      stat.buildCanonicalCharactersCharged += currentCost;
      stat.checkpointBytesBuilt += this.bytesPerDomain;
    }
    for (const domain of metrics.retainedDomains) {
      this.#stats[domain].checkpointBytesRetainedAcrossMigrations += this.bytesPerDomain;
    }
    for (const domain of metrics.evictedDomains) {
      this.#stats[domain].checkpointBytesEvicted += this.bytesPerDomain;
    }
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
      schema: "axm.ignition-adaptive-truth-checkpoint-decision/v0.23",
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
      totalCheckpointBytesRetainedAcrossMigrations: this.totalCheckpointBytesRetainedAcrossMigrations,
      reconfigurationCount: this.reconfigurationCount,
      stats: this.stats(),
    });
  }
}
