import test from "node:test";
import assert from "node:assert/strict";

import { BudgetedWorksetSession } from "../src/workset-session.js";
import { CapabilityRegistry, hashValue } from "../src/ignition-core.js";
import { runDirectRealisticBaseline } from "../src/direct-realistic-baseline.js";
import {
  REALISTIC_DOMAIN_BINDINGS,
  changeWorkspaceImportTarget,
} from "../src/realistic-mutations.js";
import {
  applyWorkspacePointMutation,
  buildWorkspaceDomainEntryIndex,
  createWorkspacePointMutationReceipt,
} from "../src/incremental-domain-index.js";
import { buildRealisticRegistry, buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";

const EXPECTED_REPORT_ORDER = [
  "workspace-dependency-index",
  "workspace-duplicate-index",
  "workspace-lint-index",
  "workspace-metadata-index",
  "workspace-search-index",
  "workspace-symbol-index",
  "workspace-report-projection",
];

test("report wakes deterministic seven-body dependency closure and equals direct baseline", async () => {
  const state = buildWorkspaceState({ fileCount: 700 });
  const stateHash = hashValue(state);
  const direct = await runDirectRealisticBaseline({
    request: realisticRequests.report,
    state,
    registry: buildRealisticRegistry(),
    stateFingerprint: stateHash,
  });
  const session = new BudgetedWorksetSession({
    registry: buildRealisticRegistry(),
    maxCacheBytes: 2_000_000,
    policy: "lru",
    domainBindings: REALISTIC_DOMAIN_BINDINGS,
  });
  try {
    const run = await session.run({ request: realisticRequests.report, state, stateFingerprint: stateHash });
    assert.deepEqual(run.result, direct.result);
    assert.deepEqual(run.receipt.executionOrder, EXPECTED_REPORT_ORDER);
    assert.equal(run.receipt.cacheHitCount, 0);
    assert.equal(run.receipt.cacheMissCount, 7);
    assert.equal(run.receipt.resultHash, direct.receipt.resultHash);
  } finally {
    await session.close({ state });
  }
});

test("report can reuse a partial warm closure then materialize only missing bodies", async () => {
  const state = buildWorkspaceState({ fileCount: 700 });
  const identity = buildWorkspaceDomainEntryIndex(state).identity;
  const session = new BudgetedWorksetSession({
    registry: buildRealisticRegistry(),
    maxCacheBytes: 2_000_000,
    policy: "lru",
    domainBindings: REALISTIC_DOMAIN_BINDINGS,
  });
  try {
    await session.run({ request: realisticRequests.search, state, domainIdentity: identity });
    await session.run({ request: realisticRequests.dependencies, state, domainIdentity: identity });
    const run = await session.run({ request: realisticRequests.report, state, domainIdentity: identity });
    assert.deepEqual(run.receipt.cacheHitCapabilityIds, [
      "workspace-dependency-index",
      "workspace-search-index",
    ]);
    assert.equal(run.receipt.cacheHitCount, 2);
    assert.equal(run.receipt.cacheMissCount, 5);
    assert.ok(run.receipt.newlyMaterializedBytes < run.receipt.closureBodyBytes);
  } finally {
    await session.close({ state });
  }
});

test("incremental truth change invalidates only stale cached body inside later workset", async () => {
  const before = buildWorkspaceState({ fileCount: 700 });
  const beforeHash = hashValue(before);
  const indexA = buildWorkspaceDomainEntryIndex(before, null, { stateHash: beforeHash });
  const after = changeWorkspaceImportTarget(before, 12, 13, 14);
  const afterHash = hashValue(after);
  const mutationReceipt = createWorkspacePointMutationReceipt({
    beforeState: before,
    afterState: after,
    fileIndex: 12,
    fromStateHash: beforeHash,
    toStateHash: afterHash,
  });
  const indexB = applyWorkspacePointMutation({ index: indexA, mutationReceipt, nextState: after });
  const direct = await runDirectRealisticBaseline({
    request: realisticRequests.report,
    state: after,
    registry: buildRealisticRegistry(),
    stateFingerprint: afterHash,
  });

  const session = new BudgetedWorksetSession({
    registry: buildRealisticRegistry(),
    maxCacheBytes: 2_000_000,
    policy: "lru",
    domainBindings: REALISTIC_DOMAIN_BINDINGS,
  });
  try {
    await session.run({ request: realisticRequests.search, state: before, domainIdentity: indexA.identity });
    await session.run({ request: realisticRequests.dependencies, state: before, domainIdentity: indexA.identity });
    const run = await session.run({ request: realisticRequests.report, state: after, domainIdentity: indexB.identity });

    assert.deepEqual(run.result, direct.result);
    assert.equal(run.receipt.cacheHitCapabilityIds.includes("workspace-search-index"), true);
    assert.equal(run.receipt.cacheHitCapabilityIds.includes("workspace-dependency-index"), false);
    assert.deepEqual(
      run.receipt.invalidatedForDomainIdentity.map((entry) => entry.capabilityId),
      ["workspace-dependency-index"]
    );
  } finally {
    await session.close({ state: after });
  }
});

test("broad closure may exceed retained budget transiently but retained cache never does", async () => {
  const state = buildWorkspaceState({ fileCount: 2500 });
  const stateHash = hashValue(state);
  const direct = await runDirectRealisticBaseline({
    request: realisticRequests.report,
    state,
    registry: buildRealisticRegistry(),
    stateFingerprint: stateHash,
  });
  const session = new BudgetedWorksetSession({
    registry: buildRealisticRegistry(),
    maxCacheBytes: 900_000,
    policy: "lru",
    domainBindings: REALISTIC_DOMAIN_BINDINGS,
  });
  try {
    const run = await session.run({ request: realisticRequests.report, state, stateFingerprint: stateHash });
    assert.deepEqual(run.result, direct.result);
    assert.equal(run.receipt.closureBodyBytes, direct.receipt.actualMaterializedBytes);
    assert.ok(run.receipt.closureBodyBytes > run.receipt.retainedBudgetBytes);
    assert.ok(run.receipt.cacheBytesAfter <= 900_000);
    assert.ok(run.receipt.budgetEvictions.length + run.receipt.transientCapabilityIds.length > 0);
  } finally {
    await session.close({ state });
  }
});

test("zero-retention broad report has no materialization advantage over direct execution", async () => {
  const state = buildWorkspaceState({ fileCount: 700 });
  const stateHash = hashValue(state);
  const direct = await runDirectRealisticBaseline({
    request: realisticRequests.report,
    state,
    registry: buildRealisticRegistry(),
    stateFingerprint: stateHash,
  });
  const session = new BudgetedWorksetSession({
    registry: buildRealisticRegistry(),
    maxCacheBytes: 0,
    policy: "none",
    domainBindings: REALISTIC_DOMAIN_BINDINGS,
  });
  try {
    const run = await session.run({ request: realisticRequests.report, state, stateFingerprint: stateHash });
    assert.deepEqual(run.result, direct.result);
    assert.equal(run.receipt.newlyMaterializedBytes, direct.receipt.actualMaterializedBytes);
    assert.equal(run.receipt.cacheHitCount, 0);
    assert.equal(run.receipt.cacheBytesAfter, 0);
    assert.equal(run.receipt.transientCapabilityIds.length, 7);
  } finally {
    await session.close({ state });
  }
});

test("workset rejects missing dependencies before execution", async () => {
  const registry = new CapabilityRegistry([
    {
      id: "a",
      dependencies: ["missing"],
      match: () => true,
      run: () => "a",
    },
  ]);
  const session = new BudgetedWorksetSession({ registry, maxCacheBytes: 0, policy: "none" });
  await assert.rejects(
    () => session.run({ request: {}, state: {}, stateFingerprint: "state" }),
    /missing dependency missing required by a/
  );
});

test("workset rejects dependency cycles deterministically", async () => {
  const registry = new CapabilityRegistry([
    { id: "a", dependencies: ["b"], match: () => true, run: () => "a" },
    { id: "b", dependencies: ["a"], match: () => false, run: () => "b" },
  ]);
  const session = new BudgetedWorksetSession({ registry, maxCacheBytes: 0, policy: "none" });
  await assert.rejects(
    () => session.run({ request: {}, state: {}, stateFingerprint: "state" }),
    /capability dependency cycle detected/
  );
});
