import test from "node:test";
import assert from "node:assert/strict";

import { executeIgnitionRun, hashValue } from "../src/ignition-core.js";
import { buildWorkspaceDomainEntryIndex } from "../src/incremental-domain-index.js";
import { REALISTIC_DOMAIN_BINDINGS } from "../src/realistic-mutations.js";
import { buildRealisticRegistry, buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";
import { buildSegmentedRealisticRegistry } from "../src/segmented-search.js";
import { StreamedWorksetSession } from "../src/streamed-workset-session.js";

const queries = ["ignite", "deterministic", "workspace", "module", "truth", "does_not_exist"];

test("segmented search preserves exact monolithic results across deterministic queries", async () => {
  const state = buildWorkspaceState({ fileCount: 900 });
  const stateFingerprint = hashValue(state);
  for (const query of queries) {
    const request = { kind: "search", query };
    const whole = await executeIgnitionRun({
      registry: buildRealisticRegistry(),
      request,
      state,
      mode: "ignition",
      stateFingerprint,
    });
    const segmented = await executeIgnitionRun({
      registry: buildSegmentedRealisticRegistry({ segmentBits: 4 }),
      request,
      state,
      mode: "ignition",
      stateFingerprint,
    });
    assert.deepEqual(segmented.result, whole.result, query);
    assert.equal(segmented.receipt.resultHash, whole.receipt.resultHash, query);
  }
});

test("16-way search segmentation lowers the streamed report runtime-body peak", async () => {
  const state = buildWorkspaceState({ fileCount: 1200 });
  const stateFingerprint = hashValue(state);
  const whole = new StreamedWorksetSession({
    registry: buildRealisticRegistry(),
    maxCacheBytes: 0,
    policy: "none",
    domainBindings: REALISTIC_DOMAIN_BINDINGS,
  });
  const segmented = new StreamedWorksetSession({
    registry: buildSegmentedRealisticRegistry({ segmentBits: 4 }),
    maxCacheBytes: 0,
    policy: "none",
    domainBindings: REALISTIC_DOMAIN_BINDINGS,
  });
  try {
    const a = await whole.run({ request: realisticRequests.report, state, stateFingerprint });
    const b = await segmented.run({ request: realisticRequests.report, state, stateFingerprint });
    assert.deepEqual(b.result, a.result);
    assert.equal(b.receipt.resultHash, a.receipt.resultHash);
    assert.ok(b.receipt.peakLiveBodyBytes < a.receipt.peakLiveBodyBytes);
    assert.ok(b.receipt.newlyMaterializedBytes < a.receipt.newlyMaterializedBytes);
    assert.equal(b.receipt.cacheBytesAfter, 0);
  } finally {
    await whole.close({ state });
    await segmented.close({ state });
  }
});

test("segmentBits zero is an honest no-segmentation counterexample", async () => {
  const state = buildWorkspaceState({ fileCount: 700 });
  const stateFingerprint = hashValue(state);
  const whole = new StreamedWorksetSession({
    registry: buildRealisticRegistry(),
    maxCacheBytes: 0,
    policy: "none",
    domainBindings: REALISTIC_DOMAIN_BINDINGS,
  });
  const segmented = new StreamedWorksetSession({
    registry: buildSegmentedRealisticRegistry({ segmentBits: 0 }),
    maxCacheBytes: 0,
    policy: "none",
    domainBindings: REALISTIC_DOMAIN_BINDINGS,
  });
  try {
    const a = await whole.run({ request: realisticRequests.report, state, stateFingerprint });
    const b = await segmented.run({ request: realisticRequests.report, state, stateFingerprint });
    assert.deepEqual(b.result, a.result);
    assert.equal(b.receipt.newlyMaterializedBytes, a.receipt.newlyMaterializedBytes);
    assert.equal(b.receipt.peakLiveBodyBytes, a.receipt.peakLiveBodyBytes);
  } finally {
    await whole.close({ state });
    await segmented.close({ state });
  }
});

test("segmented search remains bound to canonical tokens-domain identity in receipts", async () => {
  const state = buildWorkspaceState({ fileCount: 650 });
  const identity = buildWorkspaceDomainEntryIndex(state).identity;
  const session = new StreamedWorksetSession({
    registry: buildSegmentedRealisticRegistry({ segmentBits: 4 }),
    maxCacheBytes: 0,
    policy: "none",
    domainBindings: REALISTIC_DOMAIN_BINDINGS,
  });
  try {
    const run = await session.run({ request: { kind: "search", query: "ignite" }, state, domainIdentity: identity });
    const receipt = run.receipt.materializationReceipts.find((entry) => entry.capabilityId === "workspace-search-index");
    assert.deepEqual(receipt.sourceDomains, ["tokens"]);
    assert.equal(typeof receipt.bodyIdentityHash, "string");
    assert.ok(receipt.bodyIdentityHash.length > 0);
  } finally {
    await session.close({ state });
  }
});

test("a segmented runtime rejects reuse for a different query segment", async () => {
  const state = buildWorkspaceState({ fileCount: 500 });
  const capability = buildSegmentedRealisticRegistry({ segmentBits: 4 }).get("workspace-search-index");
  const body = await capability.materialize({ request: { kind: "search", query: "ignite" }, state });
  assert.throws(
    () => capability.run({ request: { kind: "search", query: "deterministic" }, runtime: body.instance }),
    /does not match request segment/
  );
});
