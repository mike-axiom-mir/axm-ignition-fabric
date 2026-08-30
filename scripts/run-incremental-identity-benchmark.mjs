import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, "incremental-identity-probe.mjs");
const modes = ["full-state", "full-domain", "incremental"];
const scenarios = ["path", "import"];
const samples = 5;
const transitionCount = 6;
const fileCount = 2500;

function runProbe(mode, scenario) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [probe, mode, scenario, String(transitionCount), String(fileCount)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`incremental identity probe failed: ${mode}/${scenario} exit ${code}`));
      try {
        resolve(JSON.parse(stdout.trim().split("\n").at(-1)));
      } catch (error) {
        reject(new Error(`invalid incremental identity probe output for ${mode}/${scenario}: ${error.message}`));
      }
    });
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function stats(rows, key) {
  const values = rows.map((row) => row[key]);
  return { median: median(values), min: Math.min(...values), max: Math.max(...values) };
}

function summarize(rows) {
  return {
    sampleCount: rows.length,
    allEquivalent: rows.every((row) => row.equivalent),
    runtimeWallMs: stats(rows, "runtimeWallMs"),
    chargedEndToEndMs: stats(rows, "chargedEndToEndMs"),
    stateFingerprintBuildMs: stats(rows, "stateFingerprintBuildMs"),
    fullDomainBuildMs: stats(rows, "fullDomainBuildMs"),
    incrementalBootstrapMs: stats(rows, "incrementalBootstrapMs"),
    mutationReceiptBuildMs: stats(rows, "mutationReceiptBuildMs"),
    incrementalUpdateMs: stats(rows, "incrementalUpdateMs"),
    incrementalIdentityExtraMs: stats(rows, "incrementalIdentityExtraMs"),
    materializedBytesMedian: median(rows.map((row) => row.totalMaterializedBytes)),
    hitCountMedian: median(rows.map((row) => row.hitCount)),
    fullInvalidatedBytesMedian: median(rows.map((row) => row.fullInvalidatedBytes)),
    domainInvalidatedBytesMedian: median(rows.map((row) => row.domainInvalidatedBytes)),
    incrementalMetrics: rows[0].incrementalMetrics,
  };
}

for (const scenario of scenarios) {
  const byMode = Object.fromEntries(modes.map((mode) => [mode, []]));
  for (const mode of modes) {
    for (let sample = 0; sample < samples; sample += 1) {
      byMode[mode].push(await runProbe(mode, scenario));
    }
  }

  const summary = Object.fromEntries(modes.map((mode) => [mode, summarize(byMode[mode])]));
  if (!Object.values(summary).every((entry) => entry.allEquivalent)) throw new Error(`deterministic equivalence failed for ${scenario}`);

  const fullState = summary["full-state"];
  const fullDomain = summary["full-domain"];
  const incremental = summary.incremental;
  const report = {
    schema: "axm.ignition-incremental-identity-comparison/v0.10",
    scenario,
    fileCount,
    transitionCount,
    samples,
    modes: summary,
    observedMedianDelta: {
      incrementalVsFullStateEndToEndMs: fullState.chargedEndToEndMs.median - incremental.chargedEndToEndMs.median,
      incrementalVsFullDomainEndToEndMs: fullDomain.chargedEndToEndMs.median - incremental.chargedEndToEndMs.median,
      incrementalVsFullStateMaterializedBytes: fullState.materializedBytesMedian - incremental.materializedBytesMedian,
      incrementalVsFullDomainIdentityExtraMs: fullDomain.fullDomainBuildMs.median - incremental.incrementalIdentityExtraMs.median,
      incrementalCacheHitsVsFullState: incremental.hitCountMedian - fullState.hitCountMedian,
    },
    proofShape: {
      fullDomainReference: "All incremental identities are checked against the exact full-scan v0.09-compatible identity before runtime timing.",
      pointInspection: "Supported transitions inspect one changed file and rehash only changed domains; unchanged domain entry arrays are retained.",
      fallback: "Missing or structural mutation evidence uses full recomputation; stale/tampered/wrong-target receipts are rejected by tests.",
    },
    timingBoundary: "Five fresh-process samples per mode. Charged end-to-end includes whole-state fingerprint cost for all modes plus each mode's identity-construction/update cost and cache runtime. Direct verification is excluded.",
  };
  console.log(JSON.stringify(report));
}
