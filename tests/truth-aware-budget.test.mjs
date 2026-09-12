import test from "node:test";
import assert from "node:assert/strict";

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

async function runAndVerify(session, request, state) {
  const stateFingerprint = hashValue(state);
  const run = await session.run({ request, state, stateFingerprint });
  const direct = await runDirectRealisticBaseline({
    request,
    state,
    registry: buildRealisticRegistry(),
    stateFingerprint,
  });
  assert.deepEqual(run.result, direct.result);
  assert.equal(run.receipt.resultHash, direct.receipt.resultHash);
  assert.ok(run.receipt.cacheBytesAfter <= session.maxCacheBytes);
  return run;
}

async function warmMixedBody(session, state) {
  await runAndVerify(session, realisticRequests.search, state);
  await runAndVerify(session, realisticRequests.search, state);
  await runAndVerify(session, realisticRequests.search, state);
  await runAndVerify(session, realisticRequests.dependencies, state);
  await runAndVerify(session, realisticRequests.duplicates, state);
  await runAndVerify(session, realisticRequests.lint, state);
}

test("trusted transition removes stale bodies before hard-budget eviction and keeps valid bodies", async () => {
  const before = buildWorkspaceState({ fileCount: 1000 });
  const after = changeWorkspaceImportTarget(before, 1, 2, 3);
  const session = new BudgetedRetentionSession({
    registry: buildRealisticRegistry(),
    maxCacheBytes: 360_000,
    policy: "value",
    invalidationResolver: resolveRealisticInvalidation,
  });

  try {
    await warmMixedBody(session, before);
    assert.ok(session.cachedCapabilityIds.includes("workspace-search-index"));
    assert.ok(session.cachedCapabilityIds.includes("workspace-dependency-index"));
    assert.ok(session.cachedCapabilityIds.includes("workspace-duplicate-index"));
    assert.ok(session.cachedCapabilityIds.includes("workspace-lint-index"));

    const receipt = createWorkspaceTransitionReceipt(before, after);
    assert.deepEqual(receipt.changedDomains, ["content-hash", "imports"]);

    const transition = await session.applyTransition({ transitionReceipt: receipt, state: after });
    assert.deepEqual(
      transition.releasedCapabilityIds,
      ["workspace-dependency-index", "workspace-duplicate-index"]
    );
    assert.ok(transition.retainedValidCapabilityIds.includes("workspace-search-index"));
    assert.ok(transition.retainedValidCapabilityIds.includes("workspace-lint-index"));
    assert.ok(transition.retainedValidBytes <= session.maxCacheBytes);

    const search = await runAndVerify(session, realisticRequests.search, after);
    assert.equal(search.receipt.cacheHit, true);
    assert.equal(search.receipt.materializedBytes, 0);

    const dependency = await runAndVerify(session, realisticRequests.dependencies, after);
    const duplicate = await runAndVerify(session, realisticRequests.duplicates, after);
    assert.equal(dependency.receipt.cacheHit, false);
    assert.equal(duplicate.receipt.cacheHit, false);
    assert.ok(session.cacheBytes <= session.maxCacheBytes);
  } finally {
    await session.close({ state: after });
  }
});

test("unreceipted state change still falls back to full cache invalidation", async () => {
  const before = buildWorkspaceState({ fileCount: 500 });
  const after = changeWorkspaceImportTarget(before, 1, 2, 3);
  const session = new BudgetedRetentionSession({
    registry: buildRealisticRegistry(),
    maxCacheBytes: 300_000,
    policy: "value",
    invalidationResolver: resolveRealisticInvalidation,
  });

  try {
    await runAndVerify(session, realisticRequests.dependencies, before);
    await runAndVerify(session, realisticRequests.lint, before);
    assert.ok(session.cachedCapabilityIds.length >= 2);

    const changed = await runAndVerify(session, realisticRequests.dependencies, after);
    const invalidated = changed.receipt.invalidatedForStateChange.map((entry) => entry.capabilityId).sort();
    assert.deepEqual(invalidated, ["workspace-dependency-index", "workspace-lint-index"]);
    assert.equal(changed.receipt.cacheHit, false);
  } finally {
    await session.close({ state: after });
  }
});

test("transition receipt for the wrong canonical base is rejected before cache mutation", async () => {
  const stateA = buildWorkspaceState({ fileCount: 400 });
  const stateB = changeWorkspaceImportTarget(stateA, 1, 2, 3);
  const unrelated = buildWorkspaceState({ fileCount: 401 });
  const badReceipt = createWorkspaceTransitionReceipt(stateA, stateB);
  const session = new BudgetedRetentionSession({
    registry: buildRealisticRegistry(),
    maxCacheBytes: 250_000,
    policy: "lru",
    invalidationResolver: resolveRealisticInvalidation,
  });

  try {
    await runAndVerify(session, realisticRequests.dependencies, unrelated);
    const beforeIds = session.cachedCapabilityIds;
    const beforeBytes = session.cacheBytes;
    await assert.rejects(
      () => session.applyTransition({ transitionReceipt: badReceipt, state: stateB }),
      /fromStateHash mismatch/
    );
    assert.deepEqual(session.cachedCapabilityIds, beforeIds);
    assert.equal(session.cacheBytes, beforeBytes);
  } finally {
    await session.close({ state: unrelated });
  }
});
