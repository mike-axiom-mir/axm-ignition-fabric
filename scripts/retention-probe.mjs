import { BudgetedRetentionSession } from "../src/budgeted-retention.js";
import { runDirectRealisticBaseline } from "../src/direct-realistic-baseline.js";
import { buildRealisticRegistry, buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";

const policy = process.argv[2] || "value";
const scenario = process.argv[3] || "hot-search";
const maxCacheBytes = Number(process.argv[4] || 900000);
const fileCount = Number(process.argv[5] || 2500);

function sequenceFor(name) {
  if (name === "hot-search") {
    return [
      realisticRequests.search,
      realisticRequests.search,
      realisticRequests.search,
      realisticRequests.dependencies,
      realisticRequests.symbols,
      realisticRequests.duplicates,
      realisticRequests.lint,
      realisticRequests.search,
      realisticRequests.search,
      realisticRequests.search,
      realisticRequests.search,
      realisticRequests.search,
    ];
  }
  if (name === "low-reuse") {
    return [
      realisticRequests.dependencies,
      realisticRequests.symbols,
      realisticRequests.duplicates,
      realisticRequests.lint,
    ];
  }
  if (name === "alternating-small") {
    return Array.from({ length: 6 }, () => [realisticRequests.dependencies, realisticRequests.symbols]).flat();
  }
  throw new Error(`unknown scenario: ${name}`);
}

const state = buildWorkspaceState({ fileCount });
const requests = sequenceFor(scenario);
const expected = new Map();
for (const request of requests) {
  if (expected.has(request.kind)) continue;
  const direct = await runDirectRealisticBaseline({ request, state, registry: buildRealisticRegistry() });
  expected.set(request.kind, direct.receipt.resultHash);
}

const session = new BudgetedRetentionSession({ registry: buildRealisticRegistry(), maxCacheBytes, policy });
const runs = [];
let equivalent = true;
let totalWallMs = 0;
let totalMaterializedBytes = 0;
let hitCount = 0;
let evictionCount = 0;

try {
  for (const request of requests) {
    const started = performance.now();
    const outcome = await session.run({ request, state });
    const wallMs = performance.now() - started;
    totalWallMs += wallMs;
    totalMaterializedBytes += outcome.receipt.materializedBytes;
    if (outcome.receipt.cacheHit) hitCount += 1;
    evictionCount += outcome.receipt.evicted.length;
    if (outcome.receipt.resultHash !== expected.get(request.kind)) equivalent = false;
    if (outcome.receipt.cacheBytesAfter > maxCacheBytes) throw new Error("hard cache budget exceeded");
    runs.push({
      kind: request.kind,
      resultHash: outcome.receipt.resultHash,
      wallMs,
      cacheHit: outcome.receipt.cacheHit,
      retained: outcome.receipt.retained,
      materializedBytes: outcome.receipt.materializedBytes,
      evicted: outcome.receipt.evicted.map((entry) => entry.capabilityId),
      cacheBytesAfter: outcome.receipt.cacheBytesAfter,
      cacheCapabilityIds: outcome.receipt.cacheCapabilityIds,
    });
  }

  console.log(JSON.stringify({
    schema: "axm.ignition-retention-probe/v0.07",
    policy,
    scenario,
    fileCount,
    maxCacheBytes,
    equivalent,
    requestCount: requests.length,
    totalWallMs,
    totalMaterializedBytes,
    hitCount,
    missCount: requests.length - hitCount,
    evictionCount,
    finalCacheBytes: session.cacheBytes,
    finalCachedCapabilityIds: session.cachedCapabilityIds,
    evictionHistory: session.evictionHistory.map((entry) => ({
      capabilityId: entry.capabilityId,
      allocatedBytes: entry.allocatedBytes,
      hitCount: entry.hitCount,
      materializeMs: entry.materializeMs,
      lastUsedRun: entry.lastUsedRun,
      reason: entry.reason,
    })),
    runs,
    timingBoundary: "Outer wall-clock around BudgetedRetentionSession.run. Direct reference verification is performed before timing and excluded.",
  }));
} finally {
  await session.close({ state });
}
