import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, "adaptive-truth-checkpoint-probe.mjs");
const policies = ["none", "frequency", "oracle", "adaptive", "all-seven"];
const scenarios = ["frequency-vs-position", "phase-shift"];
const samples = 5;

function runProbe(policy, scenario) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [probe, policy, scenario], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`v0.23 probe failed: ${policy}/${scenario} exit ${code}`));
      try {
        resolve(JSON.parse(stdout.trim().split("\n").at(-1)));
      } catch (error) {
        reject(new Error(`invalid v0.23 probe output: ${policy}/${scenario}: ${error.message}`));
      }
    });
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function stats(rows, selector) {
  const values = rows.map(selector);
  return { median: median(values), min: Math.min(...values), max: Math.max(...values) };
}

function unique(rows, selector) {
  return [...new Set(rows.map(selector))];
}

function deterministicField(rows, selector, label) {
  const values = unique(rows, (row) => JSON.stringify(selector(row)));
  if (values.length !== 1) throw new Error(`${label} was not deterministic across samples`);
  return JSON.parse(values[0]);
}

function timelineShape(timeline) {
  return timeline.map(({ step, domains }) => ({ step, domains }));
}

const results = {};
for (const scenario of scenarios) {
  results[scenario] = {};
  for (const policy of policies) {
    const rows = [];
    for (let i = 0; i < samples; i += 1) rows.push(await runProbe(policy, scenario));
    const deterministic = {
      finalHash: deterministicField(rows, (row) => row.finalHash, `${scenario}/${policy}/hash`),
      finalCanonicalCharacters: deterministicField(rows, (row) => row.finalCanonicalCharacters, `${scenario}/${policy}/size`),
      finalDomainIdentity: deterministicField(rows, (row) => row.finalDomainIdentity, `${scenario}/${policy}/identity`),
      finalSelectedDomains: deterministicField(rows, (row) => row.finalSelectedDomains, `${scenario}/${policy}/selection`),
      finalDomainCheckpointBytes: deterministicField(rows, (row) => row.finalDomainCheckpointBytes, `${scenario}/${policy}/final-bytes`),
      maxPersistentDomainCheckpointBytes: deterministicField(rows, (row) => row.maxPersistentDomainCheckpointBytes, `${scenario}/${policy}/peak-bytes`),
      totalDomainCanonicalCharactersRehashed: deterministicField(rows, (row) => row.totalDomainCanonicalCharactersRehashed, `${scenario}/${policy}/domain-replay`),
      totalDomainEntriesRehashed: deterministicField(rows, (row) => row.totalDomainEntriesRehashed, `${scenario}/${policy}/entries-rehashed`),
      totalDomainEntriesSkipped: deterministicField(rows, (row) => row.totalDomainEntriesSkipped, `${scenario}/${policy}/entries-skipped`),
      totalStateFingerprintCharactersRehashed: deterministicField(rows, (row) => row.totalStateFingerprintCharactersRehashed, `${scenario}/${policy}/state-replay`),
      checkpointBuildCanonicalCharacters: deterministicField(rows, (row) => row.checkpointBuildCanonicalCharacters, `${scenario}/${policy}/build-chars`),
      checkpointBytesBuilt: deterministicField(rows, (row) => row.checkpointBytesBuilt, `${scenario}/${policy}/bytes-built`),
      checkpointBytesEvicted: deterministicField(rows, (row) => row.checkpointBytesEvicted, `${scenario}/${policy}/bytes-evicted`),
      checkpointBytesRetainedAcrossMigrations: deterministicField(rows, (row) => row.checkpointBytesRetainedAcrossMigrations, `${scenario}/${policy}/bytes-retained`),
      reconfigurationCount: deterministicField(rows, (row) => row.reconfigurationCount, `${scenario}/${policy}/reconfigs`),
      chargedDomainCanonicalWork: deterministicField(rows, (row) => row.chargedDomainCanonicalWork, `${scenario}/${policy}/charged-work`),
      selectionTimeline: deterministicField(rows, (row) => row.selectionTimeline, `${scenario}/${policy}/timeline`),
      adaptiveStats: deterministicField(rows, (row) => row.adaptiveStats, `${scenario}/${policy}/adaptive-stats`),
      overBudgetReference: deterministicField(rows, (row) => row.overBudgetReference, `${scenario}/${policy}/over-budget`),
    };
    results[scenario][policy] = {
      ...deterministic,
      wallMs: stats(rows, (row) => row.wallMs),
    };
  }

  const reference = results[scenario].none;
  for (const policy of policies.slice(1)) {
    const candidate = results[scenario][policy];
    if (candidate.finalHash !== reference.finalHash) throw new Error(`${scenario}/${policy} changed exact state hash`);
    if (candidate.finalCanonicalCharacters !== reference.finalCanonicalCharacters) throw new Error(`${scenario}/${policy} changed canonical size`);
    if (JSON.stringify(candidate.finalDomainIdentity) !== JSON.stringify(reference.finalDomainIdentity)) {
      throw new Error(`${scenario}/${policy} changed domain identity`);
    }
    if (candidate.totalStateFingerprintCharactersRehashed !== reference.totalStateFingerprintCharactersRehashed) {
      throw new Error(`${scenario}/${policy} changed v0.20 state-fingerprint replay work`);
    }
  }
}

for (const scenario of scenarios) {
  if (results[scenario].none.maxPersistentDomainCheckpointBytes !== 0) throw new Error(`${scenario} none policy retained checkpoint bytes`);
  if (results[scenario].frequency.maxPersistentDomainCheckpointBytes > 20_000) throw new Error(`${scenario} frequency policy exceeded 20 KB`);
  if (results[scenario].oracle.maxPersistentDomainCheckpointBytes > 20_000) throw new Error(`${scenario} oracle policy exceeded 20 KB`);
  if (results[scenario].adaptive.maxPersistentDomainCheckpointBytes > 20_000) throw new Error(`${scenario} adaptive policy exceeded hard 20 KB retained budget`);
  if (results[scenario]["all-seven"].maxPersistentDomainCheckpointBytes !== 70_000) throw new Error(`${scenario} all-seven reference must retain 70 KB`);
  if (!(results[scenario].adaptive.totalDomainCanonicalCharactersRehashed < results[scenario].none.totalDomainCanonicalCharactersRehashed)) {
    throw new Error(`${scenario} adaptive policy did not reduce domain replay versus none`);
  }
}

const frequencyAdaptive = results["frequency-vs-position"].adaptive;
if (JSON.stringify(results["frequency-vs-position"].frequency.finalSelectedDomains) !== JSON.stringify(["content-hash", "metadata"])) {
  throw new Error("frequency policy selection changed unexpectedly");
}
if (JSON.stringify(frequencyAdaptive.finalSelectedDomains) !== JSON.stringify(["content-hash", "imports"])) {
  throw new Error("adaptive policy failed to prefer late-value import pair over frequent early metadata");
}
if (frequencyAdaptive.reconfigurationCount !== 1) {
  throw new Error("frequency-vs-position adaptive policy should build one pair once");
}
if (frequencyAdaptive.checkpointBytesBuilt !== 20_000) {
  throw new Error("frequency-vs-position adaptive policy should build exactly 20 KB");
}
if (frequencyAdaptive.checkpointBytesRetainedAcrossMigrations !== 0) {
  throw new Error("frequency-vs-position should not report retained migration bytes");
}
if (JSON.stringify(timelineShape(frequencyAdaptive.selectionTimeline)) !== JSON.stringify([
  { step: 8, domains: ["content-hash", "imports"] },
])) {
  throw new Error("frequency-vs-position v0.22 selection decision changed");
}

const phaseAdaptive = results["phase-shift"].adaptive;
if (JSON.stringify(phaseAdaptive.finalSelectedDomains) !== JSON.stringify(["metadata"])) {
  throw new Error("phase-shift adaptive policy failed to move retention to metadata");
}
if (JSON.stringify(timelineShape(phaseAdaptive.selectionTimeline)) !== JSON.stringify([
  { step: 2, domains: ["content-hash", "imports"] },
  { step: 6, domains: ["imports", "metadata"] },
  { step: 8, domains: ["metadata"] },
])) {
  throw new Error("phase-shift v0.22 selection timeline changed");
}
if (phaseAdaptive.maxPersistentDomainCheckpointBytes !== 20_000) {
  throw new Error("phase-shift retained checkpoint peak changed");
}
if (phaseAdaptive.totalDomainCanonicalCharactersRehashed !== 496_836) {
  throw new Error("phase-shift exact domain replay work changed");
}
if (phaseAdaptive.checkpointBuildCanonicalCharacters !== 248_158) {
  throw new Error("phase-shift retained migration build work is not the sealed 248,158 characters");
}
if (phaseAdaptive.checkpointBytesBuilt !== 30_000) {
  throw new Error("phase-shift retained migration must build exactly 30 KB");
}
if (phaseAdaptive.checkpointBytesEvicted !== 20_000) {
  throw new Error("phase-shift retained migration must evict exactly 20 KB cumulatively");
}
if (phaseAdaptive.checkpointBytesRetainedAcrossMigrations !== 20_000) {
  throw new Error("phase-shift retained migration must reuse exactly 20 KB cumulatively");
}
if (phaseAdaptive.reconfigurationCount !== 3) {
  throw new Error("phase-shift selection decisions/reconfiguration count changed");
}
if (phaseAdaptive.chargedDomainCanonicalWork !== 744_994) {
  throw new Error("phase-shift charged canonical work changed");
}
for (const domain of ["content-hash", "imports", "metadata"]) {
  if (phaseAdaptive.adaptiveStats[domain].buildCount !== 1) {
    throw new Error(`phase-shift rebuilt ${domain} instead of constructing it once`);
  }
}
if (phaseAdaptive.adaptiveStats.imports.checkpointBytesRetainedAcrossMigrations !== 10_000) {
  throw new Error("imports checkpoint was not retained across the pair-to-pair migration");
}
if (phaseAdaptive.adaptiveStats.metadata.checkpointBytesRetainedAcrossMigrations !== 10_000) {
  throw new Error("metadata checkpoint was not retained across the final eviction-only migration");
}

const observedDelta = Object.fromEntries(scenarios.map((scenario) => {
  const adaptive = results[scenario].adaptive;
  const none = results[scenario].none;
  const frequency = results[scenario].frequency;
  const oracle = results[scenario].oracle;
  const full = results[scenario]["all-seven"];
  return [scenario, {
    adaptiveVsNone: {
      domainCanonicalCharactersSaved: none.totalDomainCanonicalCharactersRehashed - adaptive.totalDomainCanonicalCharactersRehashed,
      chargedDomainCanonicalWorkSaved: none.chargedDomainCanonicalWork - adaptive.chargedDomainCanonicalWork,
      timingNoneMinusAdaptiveMs: none.wallMs.median - adaptive.wallMs.median,
    },
    adaptiveVsFrequency: {
      domainCanonicalCharactersSaved: frequency.totalDomainCanonicalCharactersRehashed - adaptive.totalDomainCanonicalCharactersRehashed,
      chargedDomainCanonicalWorkSaved: frequency.chargedDomainCanonicalWork - adaptive.chargedDomainCanonicalWork,
      timingFrequencyMinusAdaptiveMs: frequency.wallMs.median - adaptive.wallMs.median,
    },
    adaptiveVsOracle: {
      chargedDomainCanonicalWorkExtra: adaptive.chargedDomainCanonicalWork - oracle.chargedDomainCanonicalWork,
      timingAdaptiveMinusOracleMs: adaptive.wallMs.median - oracle.wallMs.median,
    },
    adaptiveVsAllSeven: {
      peakPersistentCheckpointBytesSaved: full.maxPersistentDomainCheckpointBytes - adaptive.maxPersistentDomainCheckpointBytes,
      checkpointBytesBuiltSaved: full.checkpointBytesBuilt - adaptive.checkpointBytesBuilt,
      chargedDomainCanonicalWorkSaved: full.chargedDomainCanonicalWork - adaptive.chargedDomainCanonicalWork,
    },
  }];
}));

const priorV022 = Object.freeze({
  phaseShiftCheckpointBuildCanonicalCharacters: 446_008,
  phaseShiftCheckpointBytesBuilt: 50_000,
  phaseShiftDomainReplayCharacters: 496_836,
  phaseShiftMaxPersistentCheckpointBytes: 20_000,
  phaseShiftSelectionTimeline: Object.freeze([
    Object.freeze({ step: 2, domains: Object.freeze(["content-hash", "imports"]) }),
    Object.freeze({ step: 6, domains: Object.freeze(["imports", "metadata"]) }),
    Object.freeze({ step: 8, domains: Object.freeze(["metadata"]) }),
  ]),
});

const migrationDeltaVsV022 = {
  phaseShift: {
    priorCheckpointBuildCanonicalCharacters: priorV022.phaseShiftCheckpointBuildCanonicalCharacters,
    currentCheckpointBuildCanonicalCharacters: phaseAdaptive.checkpointBuildCanonicalCharacters,
    checkpointBuildCanonicalCharactersSaved: priorV022.phaseShiftCheckpointBuildCanonicalCharacters - phaseAdaptive.checkpointBuildCanonicalCharacters,
    checkpointBuildCanonicalCharactersReductionPercent: Number((((priorV022.phaseShiftCheckpointBuildCanonicalCharacters - phaseAdaptive.checkpointBuildCanonicalCharacters) / priorV022.phaseShiftCheckpointBuildCanonicalCharacters) * 100).toFixed(2)),
    priorCheckpointBytesBuilt: priorV022.phaseShiftCheckpointBytesBuilt,
    currentCheckpointBytesBuilt: phaseAdaptive.checkpointBytesBuilt,
    checkpointBytesBuiltSaved: priorV022.phaseShiftCheckpointBytesBuilt - phaseAdaptive.checkpointBytesBuilt,
    checkpointBytesBuiltReductionPercent: Number((((priorV022.phaseShiftCheckpointBytesBuilt - phaseAdaptive.checkpointBytesBuilt) / priorV022.phaseShiftCheckpointBytesBuilt) * 100).toFixed(2)),
    checkpointBytesRetainedAcrossMigrations: phaseAdaptive.checkpointBytesRetainedAcrossMigrations,
    exactReplayUnchanged: phaseAdaptive.totalDomainCanonicalCharactersRehashed === priorV022.phaseShiftDomainReplayCharacters,
    maxPersistentCheckpointBytesUnchanged: phaseAdaptive.maxPersistentDomainCheckpointBytes === priorV022.phaseShiftMaxPersistentCheckpointBytes,
    selectionTimelineUnchanged: JSON.stringify(timelineShape(phaseAdaptive.selectionTimeline)) === JSON.stringify(priorV022.phaseShiftSelectionTimeline),
  },
};

console.log(JSON.stringify({
  schema: "axm.ignition-adaptive-truth-checkpoint-comparison/v0.23",
  samples,
  fileCount: 2500,
  checkpointBudgetBytes: 20_000,
  valueWindow: 4,
  policies,
  scenarios,
  results,
  observedDelta,
  migrationDeltaVsV022,
  proofBoundary: {
    exactness: "All policies must end at the same legacy-compatible state hash, exact canonical size, domain hashes, and domain revisions for a scenario.",
    isolation: "Every policy uses the same v0.20 state-fingerprint checkpoint mechanism. The v0.22 adaptive ranking, admission rule, value window, and selection decisions remain unchanged; v0.23 changes only checkpoint-set migration.",
    hardBudget: "Adaptive, frequency, and oracle policies may retain at most 20,000 exact domain-checkpoint bytes. This is a persistent/current-set residency invariant, not a measured physical transient allocator-peak claim. The 70,000-byte all-seven policy is an explicitly over-budget reference.",
    adaptiveAdmission: "Uncheckpointed domains earn a deterministic position-weighted replay-opportunity estimate from observed full replay cost and mutation position. Retained checkpoints use actual avoided replay. A candidate must also overcome one full-domain build-cost penalty before admission.",
    retainedMigration: "A domain surviving a selection change reuses the same checkpoint record and Uint32Array identity. Only newly admitted domains are constructed; evicted domains are dropped. Tests fail if a retained checkpoint array is rebuilt.",
    buildAndEviction: "Admitted checkpoint construction runs inside the timed region. Canonical build work, bytes built, bytes evicted, bytes retained across migrations, and reconfiguration count are charged explicitly.",
    frequencyCounterexample: "The frequency-vs-position workload mutates metadata more often but at file zero, while less-frequent import/content-hash mutations occur at the tail. Frequency alone is therefore intentionally misleading.",
    phaseShift: "The phase-shift workload locks the v0.22 decisions at steps 2, 6, and 8, then proves migration can reuse surviving exact truth without changing replay work or the retained-byte ceiling.",
    timing: "Five fresh processes per policy/scenario. Shared initial no-domain-checkpoint v0.20 workspace bootstrap and external aggregate verification are excluded. Hosted medians are observations, not a hard speed invariant or a controlled cross-run comparison with v0.22.",
  },
}));
