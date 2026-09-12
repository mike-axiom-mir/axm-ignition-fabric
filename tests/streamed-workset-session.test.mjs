import test from "node:test";
import assert from "node:assert/strict";

import { CapabilityRegistry, executeIgnitionRun, hashValue } from "../src/ignition-core.js";
import {
  advanceWorkspaceDomainIndex,
  buildWorkspaceDomainEntryIndex,
  createWorkspacePointMutationReceipt,
} from "../src/incremental-domain-index.js";
import { REALISTIC_DOMAIN_BINDINGS, changeWorkspaceImportTarget } from "../src/realistic-mutations.js";
import { buildRealisticRegistry, buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";
import { StreamedWorksetSession } from "../src/streamed-workset-session.js";

test("cold streamed report preserves exact closure output while lowering declared peak body bytes", async () => {
  const state = buildWorkspaceState({ fileCount: 800 });
  const stateFingerprint = hashValue(state);
  const direct = await executeIgnitionRun({
    registry: buildRealisticRegistry(),
    request: realisticRequests.report,
    state,
    mode: "ignition",
    stateFingerprint,
  });
  const session = new StreamedWorksetSession({
    registry: buildRealisticRegistry(),
    maxCacheBytes: 0,
    policy: "none",
    domainBindings: REALISTIC_DOMAIN_BINDINGS,
  });
  try {
    const streamed = await session.run({ request: realisticRequests.report, state, stateFingerprint });
    assert.equal(streamed.receipt.resultHash, direct.receipt.resultHash);
    assert.deepEqual(streamed.result, direct.result);
    assert.deepEqual(streamed.receipt.executionOrder, direct.receipt.executedCapabilityIds);
    assert.equal(streamed.receipt.newlyMaterializedBytes, direct.receipt.actualMaterializedBytes);
    assert.ok(streamed.receipt.peakLiveBodyBytes < streamed.receipt.newlyMaterializedBytes);
    assert.equal(streamed.receipt.transientCapabilityIds.length, 7);
    assert.equal(streamed.receipt.cacheBytesAfter, 0);
  } finally {
    await session.close({ state });
  }
});

test("single-body request is an honest no-peak-savings case", async () => {
  const state = buildWorkspaceState({ fileCount: 500 });
  const session = new StreamedWorksetSession({
    registry: buildRealisticRegistry(),
    maxCacheBytes: 0,
    policy: "none",
    domainBindings: REALISTIC_DOMAIN_BINDINGS,
  });
  try {
    const run = await session.run({ request: realisticRequests.dependencies, state, stateFingerprint: hashValue(state) });
    assert.equal(run.receipt.cacheMissCount, 1);
    assert.equal(run.receipt.peakLiveBodyBytes, run.receipt.newlyMaterializedBytes);
    assert.equal(run.receipt.cacheBytesAfter, 0);
  } finally {
    await session.close({ state });
  }
});

test("partial warm cache can feed a streamed seven-body report without keeping all misses live", async () => {
  const state = buildWorkspaceState({ fileCount: 1200 });
  const identity = buildWorkspaceDomainEntryIndex(state).identity;
  const session = new StreamedWorksetSession({
    registry: buildRealisticRegistry(),
    maxCacheBytes: 900_000,
    policy: "value",
    domainBindings: REALISTIC_DOMAIN_BINDINGS,
  });
  try {
    await session.run({ request: realisticRequests.dependencies, state, domainIdentity: identity });
    await session.run({ request: realisticRequests.search, state, domainIdentity: identity });
    const report = await session.run({ request: realisticRequests.report, state, domainIdentity: identity });
    assert.ok(report.receipt.cacheHitCapabilityIds.includes("workspace-dependency-index"));
    assert.ok(report.receipt.cacheHitCapabilityIds.includes("workspace-search-index"));
    assert.ok(report.receipt.cacheMissCount > 0);
    assert.ok(report.receipt.peakLiveBodyBytes <= 900_000 + Math.max(...report.receipt.materializationReceipts.map((entry) => entry.allocatedBytes)));
    assert.ok(report.receipt.cacheBytesAfter <= 900_000);
  } finally {
    await session.close({ state });
  }
});

test("incremental truth mutation invalidates only stale cached body before streamed closure runs", async () => {
  const before = buildWorkspaceState({ fileCount: 900 });
  let finalState = before;
  const beforeHash = hashValue(before);
  let index = buildWorkspaceDomainEntryIndex(before, null, { stateHash: beforeHash });
  const session = new StreamedWorksetSession({
    registry: buildRealisticRegistry(),
    maxCacheBytes: 900_000,
    policy: "value",
    domainBindings: REALISTIC_DOMAIN_BINDINGS,
  });
  try {
    await session.run({ request: realisticRequests.dependencies, state: before, domainIdentity: index.identity });
    await session.run({ request: realisticRequests.search, state: before, domainIdentity: index.identity });

    const fileId = 12;
    const after = changeWorkspaceImportTarget(before, fileId, fileId + 1, fileId + 2);
    finalState = after;
    const afterHash = hashValue(after);
    const receipt = createWorkspacePointMutationReceipt({
      beforeState: before,
      afterState: after,
      fileIndex: fileId,
      fromStateHash: beforeHash,
      toStateHash: afterHash,
    });
    index = advanceWorkspaceDomainIndex({ index, nextState: after, mutationReceipt: receipt });

    const report = await session.run({ request: realisticRequests.report, state: after, domainIdentity: index.identity });
    assert.ok(report.receipt.invalidatedForDomainIdentity.some((entry) => entry.capabilityId === "workspace-dependency-index"));
    assert.ok(!report.receipt.invalidatedForDomainIdentity.some((entry) => entry.capabilityId === "workspace-search-index"));
    assert.ok(report.receipt.cacheMissCapabilityIds.includes("workspace-dependency-index"));
    assert.ok(report.receipt.cacheHitCapabilityIds.includes("workspace-search-index"));
  } finally {
    await session.close({ state: finalState });
  }
});

test("repeated streamed broad work respects retained budget even when one executing miss pushes live bytes above it", async () => {
  const state = buildWorkspaceState({ fileCount: 2500 });
  const identity = buildWorkspaceDomainEntryIndex(state).identity;
  const session = new StreamedWorksetSession({
    registry: buildRealisticRegistry(),
    maxCacheBytes: 900_000,
    policy: "value",
    domainBindings: REALISTIC_DOMAIN_BINDINGS,
  });
  try {
    let observedHit = false;
    for (let i = 0; i < 3; i += 1) {
      const run = await session.run({ request: realisticRequests.report, state, domainIdentity: identity });
      observedHit ||= run.receipt.cacheHitCount > 0;
      assert.ok(run.receipt.cacheBytesAfter <= 900_000);
      assert.equal(run.receipt.resultHash, hashValue(run.result));
    }
    assert.equal(observedHit, true);
    assert.ok(session.cacheBytes <= 900_000);
  } finally {
    await session.close({ state });
  }
});

test("streamed planner rejects dependency cycles deterministically", async () => {
  const registry = new CapabilityRegistry([
    { id: "a", dependencies: ["b"], match: () => true, run: () => ({ a: true }) },
    { id: "b", dependencies: ["a"], match: () => false, run: () => ({ b: true }) },
  ]);
  const session = new StreamedWorksetSession({ registry, maxCacheBytes: 0, policy: "none" });
  await assert.rejects(
    () => session.run({ request: { kind: "cycle" }, state: {} }),
    /dependency cycle/
  );
  await session.close();
});
