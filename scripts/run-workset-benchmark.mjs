import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, "workset-probe.mjs");
const modes = ["direct", "workset"];
const scenarios = ["partial", "mutation", "tight", "none"];
const samples = 5;
const fileCount = 2500;

function runProbe(mode, scenario) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [probe, mode, scenario, String(fileCount)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`workset probe failed: ${mode}/${scenario} exit ${code}`));
      try {
        resolve(JSON.parse(stdout.trim().split("\n").at(-1)));
      } catch (error) {
        reject(new Error(`invalid workset probe output for ${mode}/${scenario}: ${error.message}`));
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
  const values = rows.map((row) => Number(row[key] || 0));
  return { median: median(values), min: Math.min(...values), max: Math.max(...values) };
}

function summarize(rows) {
  return {
    sampleCount: rows.length,
    allEquivalent: rows.every((row) => row.equivalent),
    reportRuns: rows[0].reportRuns,
    stateHashBuildMs: stats(rows, "stateHashBuildMs"),
    identityBuildMs: stats(rows, "identityBuildMs"),
    primeWallMs: stats(rows, "primeWallMs"),
    mutationReceiptBuildMs: stats(rows, "mutationReceiptBuildMs"),
    identityAdvanceMs: stats(rows, "identityAdvanceMs"),
    identitySpecificMs: stats(rows, "identitySpecificMs"),
    reportWallMs: stats(rows, "reportWallMs"),
    chargedLifecycleMs: stats(rows, "chargedLifecycleMs"),
    totalMaterializedBytesMedian: median(rows.map((row) => row.totalMaterializedBytes)),
    reportMaterializedBytesMedian: median(rows.map((row) => row.reportMaterializedBytes)),
    reportCacheHitsMedian: median(rows.map((row) => row.reportCacheHits)),
    reportCacheMissesMedian: median(rows.map((row) => row.reportCacheMisses)),
    budgetEvictionCountMedian: median(rows.map((row) => row.budgetEvictionCount)),
    transientCountMedian: median(rows.map((row) => row.transientCount)),
    cacheBytesAfterMedian: median(rows.map((row) => row.cacheBytesAfter)),
    closureBodyBytesMedian: median(rows.map((row) => row.closureBodyBytes)),
    invalidatedCapabilityIds: [...new Set(rows.flatMap((row) => row.reportInvalidatedCapabilityIds))].sort(),
    finalCacheCapabilityIds: rows[0].finalCacheCapabilityIds,
    executionOrder: rows[0].executionOrder,
    incrementalFilesInspected: median(rows.map((row) => row.incrementalFilesInspected)),
    incrementalDomainsRehashed: median(rows.map((row) => row.incrementalDomainsRehashed)),
  };
}

for (const scenario of scenarios) {
  const samplesByMode = { direct: [], workset: [] };
  for (const mode of modes) {
    for (let sample = 0; sample < samples; sample += 1) {
      samplesByMode[mode].push(await runProbe(mode, scenario));
    }
  }

  const direct = summarize(samplesByMode.direct);
  const workset = summarize(samplesByMode.workset);
  if (!direct.allEquivalent || !workset.allEquivalent) throw new Error(`workset equivalence failed for ${scenario}`);

  if (scenario === "partial" && workset.reportCacheHitsMedian !== 2) {
    throw new Error(`partial workset expected exactly 2 report cache hits, got ${workset.reportCacheHitsMedian}`);
  }
  if (scenario === "mutation") {
    if (!workset.invalidatedCapabilityIds.includes("workspace-dependency-index")) {
      throw new Error("mutation workset did not invalidate dependency body");
    }
    if (workset.reportCacheHitsMedian < 1) throw new Error("mutation workset failed to preserve any valid warm body");
  }
  if (scenario === "tight") {
    if (workset.cacheBytesAfterMedian > 900_000) throw new Error("tight workset exceeded retained cache budget");
    if (workset.closureBodyBytesMedian <= 900_000) throw new Error("tight scenario did not exercise closure larger than retained budget");
  }
  if (scenario === "none") {
    if (workset.reportMaterializedBytesMedian !== direct.reportMaterializedBytesMedian) {
      throw new Error("zero-retention broad case unexpectedly changed materialization bytes");
    }
    if (workset.cacheBytesAfterMedian !== 0) throw new Error("zero-retention workset retained cache bytes");
  }

  const report = {
    schema: "axm.ignition-workset-comparison/v0.11",
    scenario,
    fileCount,
    samples,
    direct,
    workset,
    observedMedianDelta: {
      reportWallMsDirectMinusWorkset: direct.reportWallMs.median - workset.reportWallMs.median,
      chargedLifecycleMsDirectMinusWorkset: direct.chargedLifecycleMs.median - workset.chargedLifecycleMs.median,
      reportMaterializedBytesDirectMinusWorkset: direct.reportMaterializedBytesMedian - workset.reportMaterializedBytesMedian,
      totalMaterializedBytesDirectMinusWorkset: direct.totalMaterializedBytesMedian - workset.totalMaterializedBytesMedian,
      reportCacheHitsWorksetMinusDirect: workset.reportCacheHitsMedian - direct.reportCacheHitsMedian,
    },
    interpretation: {
      partial: scenario === "partial" ? "Two previously useful bodies are warm before a seven-body report. Priming cost is reported and charged separately from the report-only reuse observation." : null,
      mutation: scenario === "mutation" ? "An import mutation advances the incremental identity. The stale dependency body must miss while the token-bound search body remains eligible to hit." : null,
      tight: scenario === "tight" ? "Three broad reports run under a 900 KB retained cache even though the required closure is larger. Required misses may be transient during execution." : null,
      none: scenario === "none" ? "With zero retention and one broad report, workset and direct execution materialize the same required bytes. There is no materialization advantage by construction; timing may favor the simpler route." : null,
    },
    truthBoundary: "The hard ceiling is retained-cache memory, not a claim that transient execution allocations cannot exceed it. Every result is checked against the deterministic direct report hash.",
    timingBoundary: "Five fresh Node processes per mode. Direct reference verification is excluded. Charged lifecycle includes state fingerprint, identity bootstrap/update where applicable, explicit priming where applicable, and report execution.",
  };
  console.log(JSON.stringify(report));
}
