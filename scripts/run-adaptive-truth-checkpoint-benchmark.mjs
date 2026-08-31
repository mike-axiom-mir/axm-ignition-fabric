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
      if (code !== 0) return reject(new Error(`v0.22 probe failed: ${policy}/${scenario} exit ${code}`));
      try {
        resolve(JSON.parse(stdout.trim().split("\n").at(-1)));
      } catch (error) {
        reject(new Error(`invalid v0.22 probe output: ${policy}/${scenario}: ${error.message}`));
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
  if (results[scenario].adaptive.maxPersistentDomainCheckpointBytes > 20_000) throw new Error(`${scenario} adaptive policy exceeded hard 20 KB budget`);
  if (results[scenario]["all-seven"].maxPersistentDomainCheckpointBytes !== 70_000) throw new Error(`${scenario} all-seven reference must retain 70 KB`);
  if (!(results[scenario].adaptive.totalDomainCanonicalCharactersRehashed < results[scenario].none.totalDomainCanonicalCharactersRehashed)) {
    throw new Error(`${scenario} adaptive policy did not reduce domain replay versus none`);
  }
}

if (JSON.stringify(results["frequency-vs-position"].frequency.finalSelectedDomains) !== JSON.stringify(["content-hash", "metadata"])) {
  throw new Error("frequency policy selection changed unexpectedly");
}
if (JSON.stringify(results["frequency-vs-position"].adaptive.finalSelectedDomains) !== JSON.stringify(["content-hash", "imports"])) {
  throw new Error("adaptive policy failed to prefer late-value import pair over frequent early metadata");
}
if (results["frequency-vs-position"].adaptive.reconfigurationCount !== 1) {
  throw new Error("frequency-vs-position adaptive policy should build one pair once");
}
if (results["frequency-vs-position"].adaptive.checkpointBytesBuilt !== 20_000) {
  throw new Error("frequency-vs-position adaptive policy should build exactly 20 KB");
}

if (JSON.stringify(results["phase-shift"].adaptive.finalSelectedDomains) !== JSON.stringify(["metadata"])) {
  throw new Error("phase-shift adaptive policy failed to move retention to metadata");
}
if (results["phase-shift"].adaptive.checkpointBytesEvicted < 20_000) {
  throw new Error("phase-shift adaptive policy did not charge import-pair eviction");
}
if (results["phase-shift"].adaptive.reconfigurationCount < 2) {
  throw new Error("phase-shift adaptive policy did not reconfigure twice");
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

console.log(JSON.stringify({
  schema: "axm.ignition-adaptive-truth-checkpoint-comparison/v0.22",
  samples,
  fileCount: 2500,
  checkpointBudgetBytes: 20_000,
  valueWindow: 4,
  policies,
  scenarios,
  results,
  observedDelta,
  proofBoundary: {
    exactness: "All policies must end at the same legacy-compatible state hash, exact canonical size, domain hashes, and domain revisions for a scenario.",
    isolation: "Every policy uses the same v0.20 state-fingerprint checkpoint mechanism and must report identical state-fingerprint replay work. v0.22 varies only domain-checkpoint retention.",
    hardBudget: "Adaptive, frequency, and oracle policies may retain at most 20,000 domain-checkpoint bytes. The 70,000-byte all-seven policy is an explicitly over-budget reference, not a compliant contestant.",
    adaptiveAdmission: "Uncheckpointed domains earn a deterministic position-weighted replay-opportunity estimate from observed full replay cost and mutation position. Retained checkpoints use actual avoided replay. A candidate must also overcome one full-domain build-cost penalty before admission.",
    buildAndEviction: "Checkpoint-set construction/rebuilds run inside the timed region. Canonical build work, bytes built, bytes evicted, and reconfiguration count are charged explicitly. The current v0.22 implementation rebuilds the selected set when selection changes, including retained members.",
    frequencyCounterexample: "The frequency-vs-position workload mutates metadata more often but at file zero, while less-frequent import/content-hash mutations occur at the tail. Frequency alone is therefore intentionally misleading.",
    phaseShift: "The phase-shift workload tests whether recent-value retention can evict previously useful import checkpoints and move the hard budget to late metadata truth.",
    timing: "Five fresh processes per policy/scenario. Shared initial no-domain-checkpoint v0.20 workspace bootstrap and external aggregate verification are excluded. Hosted medians are observations, not a hard speed invariant.",
  },
}));
