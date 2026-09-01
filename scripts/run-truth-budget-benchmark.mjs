import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const probePath = fileURLToPath(new URL("./truth-budget-probe.mjs", import.meta.url));
const fileCount = 2500;
const transitionCount = 4;
const maxCacheBytes = 900000;

function probe(strategy) {
  const stdout = execFileSync(
    process.execPath,
    ["--expose-gc", probePath, strategy, String(fileCount), String(transitionCount), String(maxCacheBytes)],
    { encoding: "utf8" }
  );
  return JSON.parse(stdout.trim());
}

const full = probe("full");
const scoped = probe("scoped");
if (!full.equivalent || !scoped.equivalent) process.exitCode = 1;

console.log(JSON.stringify({
  schema: "axm.ignition-truth-budget-comparison/v0.08",
  fileCount,
  transitionCount,
  maxCacheBytes,
  equivalent: full.equivalent && scoped.equivalent,
  fullInvalidation: {
    totalWallMs: full.totalWallMs,
    totalStaleReleasedBytes: full.totalStaleReleasedBytes,
    totalBudgetEvictedBytes: full.totalBudgetEvictedBytes,
    totalMaterializedBytes: full.totalMaterializedBytes,
    totalHits: full.totalHits,
    totalMisses: full.totalMisses,
    finalCacheBytes: full.finalCacheBytes,
  },
  scopedInvalidation: {
    totalWallMs: scoped.totalWallMs,
    totalStaleReleasedBytes: scoped.totalStaleReleasedBytes,
    totalBudgetEvictedBytes: scoped.totalBudgetEvictedBytes,
    totalMaterializedBytes: scoped.totalMaterializedBytes,
    totalHits: scoped.totalHits,
    totalMisses: scoped.totalMisses,
    finalCacheBytes: scoped.finalCacheBytes,
  },
  avoidedByScopedTruth: {
    staleReleasedBytes: full.totalStaleReleasedBytes - scoped.totalStaleReleasedBytes,
    materializedBytes: full.totalMaterializedBytes - scoped.totalMaterializedBytes,
    wallMsObserved: full.totalWallMs - scoped.totalWallMs,
    extraCacheHits: scoped.totalHits - full.totalHits,
  },
  scopedTransitionSummaries: scoped.transitions.map((entry) => ({
    index: entry.index,
    changedDomains: entry.changedDomains,
    staleReleasedCapabilityIds: entry.staleReleasedCapabilityIds,
    staleReleasedBytes: entry.staleReleasedBytes,
    budgetEvictedBytes: entry.budgetEvictedBytes,
    materializedBytes: entry.materializedBytes,
    hits: entry.hits,
    misses: entry.misses,
    finalCacheBytes: entry.finalCacheBytes,
    finalCacheCapabilityIds: entry.finalCacheCapabilityIds,
  })),
  timingBoundary: scoped.timingBoundary,
  truthBoundary: "Scoped reuse is valid only when the hash-bound upstream transition receipt and explicit source-domain bindings are complete and truthful. Otherwise full invalidation remains the fallback.",
}));
