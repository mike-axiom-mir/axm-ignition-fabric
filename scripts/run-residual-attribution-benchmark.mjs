import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, "residual-attribution-probe.mjs");
const samples = 5;
const fileCount = 2500;

function runProbe() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--expose-gc", probe, String(fileCount)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`residual attribution probe exit ${code}`));
      try {
        resolve(JSON.parse(stdout.trim().split("\n").at(-1)));
      } catch (error) {
        reject(new Error(`invalid residual attribution probe output: ${error.message}`));
      }
    });
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function stats(values) {
  return {
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function stage(row, name) {
  const found = row.stages.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing residual attribution stage ${name}`);
  return found.memory;
}

function delta(row, from, to, field) {
  return stage(row, to)[field] - stage(row, from)[field];
}

function recovered(row, before, after, field) {
  return stage(row, before)[field] - stage(row, after)[field];
}

const rows = [];
for (let i = 0; i < samples; i += 1) rows.push(await runProbe());

const resultHashes = [...new Set(rows.map((row) => row.logicalRun.resultHash))];
if (resultHashes.length !== 1 || resultHashes[0] !== "daa06e7e") {
  throw new Error(`v0.15 report result drift: ${resultHashes.join(",")}`);
}
for (const row of rows) {
  if (row.logicalRun.totalMaterializedBytes !== 147572) throw new Error("v0.15 total materialized bytes drift");
  if (row.logicalRun.declaredPeakLiveBodyBytes !== 39820) throw new Error("v0.15 declared live-body peak drift");
  if (row.logicalRun.cacheBytesAfter !== 0) throw new Error("v0.15 zero-retention cache drift");
  if (row.logicalRun.resourceSnapshotsStoredInReceipt !== 0) throw new Error("v0.15 peak probe leaked snapshots into receipt");
  if (row.runPeak.deltaFromPreRun.arrayBuffers !== row.logicalRun.declaredPeakLiveBodyBytes) {
    throw new Error("v0.15 ArrayBuffer peak no longer matches declared live-body peak");
  }
}

const memoryFields = rows[0].memoryFields;
const stageNames = rows[0].stages.map((entry) => entry.name);
const stageMedians = Object.fromEntries(stageNames.map((name) => [
  name,
  Object.fromEntries(memoryFields.map((field) => [field, stats(rows.map((row) => stage(row, name)[field]))])),
]));

const attributions = {
  registryCreated: ["boot-modules-loaded", "registry-created", "delta"],
  sessionCreated: ["registry-created", "session-created", "delta"],
  canonicalStateCreated: ["session-created", "canonical-state-created", "delta"],
  fingerprintRetained: ["canonical-state-created", "state-fingerprint-retained", "delta"],
  postRunRetained: ["state-fingerprint-retained", "run-result-retained", "delta"],
  sessionCloseRecovered: ["run-result-retained", "session-closed-result-retained", "recovered"],
  resultDropRecovered: ["session-closed-result-retained", "run-result-dropped", "recovered"],
  fingerprintDropRecovered: ["run-result-dropped", "fingerprint-variable-dropped", "recovered"],
  canonicalStateDropRecovered: ["fingerprint-variable-dropped", "canonical-state-dropped", "recovered"],
  frameworkDropRecovered: ["canonical-state-dropped", "framework-objects-dropped", "recovered"],
  finalResidualVsBoot: ["boot-modules-loaded", "framework-objects-dropped", "delta"],
};

const attributionStats = Object.fromEntries(Object.entries(attributions).map(([name, [from, to, mode]]) => [
  name,
  Object.fromEntries(memoryFields.map((field) => {
    const values = rows.map((row) => mode === "recovered"
      ? recovered(row, from, to, field)
      : delta(row, from, to, field));
    return [field, stats(values)];
  })),
]));

const runPeakDeltaFromPreRun = Object.fromEntries(memoryFields.map((field) => [
  field,
  stats(rows.map((row) => row.runPeak.deltaFromPreRun[field])),
]));

const runPeakSites = Object.fromEntries(memoryFields.map((field) => {
  const counts = new Map();
  for (const row of rows) {
    for (const site of row.runPeak.sites[field]) {
      const key = `${site.phase}:${site.capabilityId ?? "none"}:live${site.liveBodyBytes}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [field, [...counts.entries()].map(([site, count]) => ({ site, count }))];
}));

console.log(JSON.stringify({
  schema: "axm.ignition-whole-process-residual-comparison/v0.15",
  fileCount,
  samples,
  resultHash: resultHashes[0],
  canonicalStateFacts: rows[0].canonicalStateFacts,
  logicalRun: rows[0].logicalRun,
  memoryFields,
  stageMedians,
  attributionStats,
  runPeakDeltaFromPreRun,
  runPeakSites,
  interpretationBoundary: {
    separateEnvelopes: "RSS, heapTotal, heapUsed, external, ArrayBuffer, and V8 malloced memory overlap in implementation and are not additive categories.",
    recoveredSign: "Recovered values are before-minus-after; positive means the measured field fell after the named lifetime ended, negative means it rose/noise or allocator behavior dominated.",
    state: "canonicalStateCreated/canonicalStateDropRecovered bound the persistent 2,500-file JavaScript truth fixture in this process shape, not a universal state representation cost.",
    execution: "runPeakDeltaFromPreRun isolates execution peak above the already-loaded framework + canonical state + fingerprint baseline. ArrayBuffer is required to remain equal to the 39,820 B declared live runtime-body peak from v0.14.",
    rss: "RSS may remain resident after references are dropped; no immediate OS return invariant is asserted.",
  },
}));
