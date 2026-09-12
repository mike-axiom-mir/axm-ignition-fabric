import { BudgetedRetentionSession } from "../src/budgeted-retention.js";
import { hashValue } from "../src/ignition-core.js";
import { runDirectRealisticBaseline } from "../src/direct-realistic-baseline.js";
import {
  changeWorkspaceImportTarget,
  createWorkspaceTransitionReceipt,
  resolveRealisticInvalidation,
} from "../src/realistic-mutations.js";
import {
  buildRealisticRegistry,
  buildWorkspaceState,
  realisticRequests,
} from "../src/realistic-workload.js";

const strategy = process.argv[2] || "scoped";
const fileCount = Number(process.argv[3] || 2500);
const transitionCount = Number(process.argv[4] || 4);
const maxCacheBytes = Number(process.argv[5] || 900000);

if (!["full", "scoped"].includes(strategy)) throw new Error("strategy must be full or scoped");
if (!Number.isInteger(fileCount) || fileCount < 100) throw new Error("fileCount must be >= 100");
if (!Number.isInteger(transitionCount) || transitionCount < 1 || transitionCount > 20) throw new Error("transitionCount must be 1..20");
if (!Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 1) throw new Error("maxCacheBytes must be positive");

const warmRequests = [
  realisticRequests.search,
  realisticRequests.search,
  realisticRequests.search,
  realisticRequests.dependencies,
  realisticRequests.duplicates,
  realisticRequests.lint,
];

const postTransitionRequests = [
  realisticRequests.dependencies,
  realisticRequests.duplicates,
  realisticRequests.symbols,
  { kind: "metadata" },
  realisticRequests.search,
  realisticRequests.lint,
];

function buildTransitionChain() {
  const states = [buildWorkspaceState({ fileCount })];
  const receipts = [];
  let fromTarget = 2;
  let toTarget = 3;
  for (let i = 0; i < transitionCount; i += 1) {
    const before = states.at(-1);
    const after = changeWorkspaceImportTarget(before, 1, fromTarget, toTarget);
    const receipt = createWorkspaceTransitionReceipt(before, after);
    states.push(after);
    receipts.push(receipt);
    [fromTarget, toTarget] = [toTarget, fromTarget];
  }
  return { states, receipts };
}

async function expectedHashesFor(state) {
  const stateFingerprint = hashValue(state);
  const registry = buildRealisticRegistry();
  const expected = new Map();
  for (const request of postTransitionRequests) {
    const direct = await runDirectRealisticBaseline({ request, state, registry, stateFingerprint });
    expected.set(JSON.stringify(request), direct.receipt.resultHash);
  }
  return expected;
}

const { states, receipts } = buildTransitionChain();
const expectedByTransition = [];
for (let i = 1; i < states.length; i += 1) expectedByTransition.push(await expectedHashesFor(states[i]));

const session = new BudgetedRetentionSession({
  registry: buildRealisticRegistry(),
  maxCacheBytes,
  policy: "value",
  invalidationResolver: resolveRealisticInvalidation,
});

let equivalent = true;
let totalWallMs = 0;
let totalStaleReleasedBytes = 0;
let totalBudgetEvictedBytes = 0;
let totalMaterializedBytes = 0;
let totalHits = 0;
let totalMisses = 0;
const transitionResults = [];

try {
  const initialState = states[0];
  const initialFingerprint = hashValue(initialState);
  for (const request of warmRequests) {
    await session.run({ request, state: initialState, stateFingerprint: initialFingerprint });
  }

  const initialCache = {
    bytes: session.cacheBytes,
    capabilityIds: session.cachedCapabilityIds,
  };

  for (let i = 0; i < receipts.length; i += 1) {
    const state = states[i + 1];
    const stateFingerprint = receipts[i].toStateHash;
    const expected = expectedByTransition[i];
    let transitionReceipt = null;
    const started = performance.now();

    if (strategy === "scoped") {
      transitionReceipt = await session.applyTransition({ transitionReceipt: receipts[i], state });
      totalStaleReleasedBytes += transitionReceipt.releasedBytes;
    }

    let firstFallbackInvalidationBytes = 0;
    let transitionMaterializedBytes = 0;
    let transitionBudgetEvictedBytes = 0;
    let transitionHits = 0;
    let transitionMisses = 0;
    const runs = [];

    for (const request of postTransitionRequests) {
      const run = await session.run({ request, state, stateFingerprint });
      const expectedHash = expected.get(JSON.stringify(request));
      if (run.receipt.resultHash !== expectedHash) equivalent = false;

      const fallbackBytes = (run.receipt.invalidatedForStateChange || [])
        .reduce((sum, entry) => sum + entry.allocatedBytes, 0);
      if (fallbackBytes && firstFallbackInvalidationBytes === 0) {
        firstFallbackInvalidationBytes = fallbackBytes;
        totalStaleReleasedBytes += fallbackBytes;
      }

      const budgetBytes = (run.receipt.evicted || [])
        .reduce((sum, entry) => sum + entry.allocatedBytes, 0);
      transitionBudgetEvictedBytes += budgetBytes;
      totalBudgetEvictedBytes += budgetBytes;
      transitionMaterializedBytes += run.receipt.materializedBytes;
      totalMaterializedBytes += run.receipt.materializedBytes;
      if (run.receipt.cacheHit) {
        transitionHits += 1;
        totalHits += 1;
      } else {
        transitionMisses += 1;
        totalMisses += 1;
      }

      if (run.receipt.cacheBytesAfter > maxCacheBytes) throw new Error("hard cache ceiling exceeded");
      runs.push({
        kind: request.kind,
        cacheHit: run.receipt.cacheHit,
        materializedBytes: run.receipt.materializedBytes,
        evictedCapabilityIds: run.receipt.evicted.map((entry) => entry.capabilityId),
        cacheBytesAfter: run.receipt.cacheBytesAfter,
        cacheCapabilityIds: run.receipt.cacheCapabilityIds,
        resultHash: run.receipt.resultHash,
      });
    }

    const wallMs = performance.now() - started;
    totalWallMs += wallMs;
    transitionResults.push({
      index: i + 1,
      changedDomains: [...receipts[i].changedDomains],
      staleReleasedCapabilityIds: transitionReceipt
        ? transitionReceipt.releasedCapabilityIds
        : strategy === "full"
          ? ["full-cache-fallback"]
          : [],
      staleReleasedBytes: transitionReceipt?.releasedBytes ?? firstFallbackInvalidationBytes,
      materializedBytes: transitionMaterializedBytes,
      budgetEvictedBytes: transitionBudgetEvictedBytes,
      hits: transitionHits,
      misses: transitionMisses,
      wallMs,
      finalCacheBytes: session.cacheBytes,
      finalCacheCapabilityIds: session.cachedCapabilityIds,
      runs,
    });
  }

  console.log(JSON.stringify({
    schema: "axm.ignition-truth-budget-probe/v0.08",
    strategy,
    fileCount,
    transitionCount,
    maxCacheBytes,
    equivalent,
    initialCache,
    totalWallMs,
    totalStaleReleasedBytes,
    totalBudgetEvictedBytes,
    totalMaterializedBytes,
    totalHits,
    totalMisses,
    finalCacheBytes: session.cacheBytes,
    finalCacheCapabilityIds: session.cachedCapabilityIds,
    transitions: transitionResults,
    timingBoundary: "Upstream transition-receipt generation and direct-baseline verification are excluded. Measured time includes stale invalidation/fallback, hard-budget eviction, materialization, and post-transition execution.",
  }));
} finally {
  await session.close({ state: states.at(-1) });
}
