import test from "node:test";
import assert from "node:assert/strict";

import { executeIgnitionRun } from "../src/ignition-core.js";
import { IgnitionSession } from "../src/ignition-session.js";
import { runDirectRealisticBaseline } from "../src/direct-realistic-baseline.js";
import { buildRealisticRegistry, buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";

test("direct route and generic cold Ignition preserve exact results", async () => {
  const state = buildWorkspaceState({ fileCount: 500 });
  const registry = buildRealisticRegistry();
  const direct = await runDirectRealisticBaseline({ request: realisticRequests.dependencies, state, registry });
  const ignition = await executeIgnitionRun({ registry, request: realisticRequests.dependencies, state, mode: "ignition" });

  assert.deepEqual(direct.result, ignition.result);
  assert.equal(direct.receipt.resultHash, ignition.receipt.resultHash);
  assert.equal(direct.receipt.actualMaterializedBytes, ignition.receipt.actualMaterializedBytes);
});

test("warm Ignition materializes once and reuses the deterministic body", async () => {
  const state = buildWorkspaceState({ fileCount: 500 });
  const session = new IgnitionSession({ registry: buildRealisticRegistry(), mode: "ignition" });
  try {
    const first = await session.run({ request: realisticRequests.dependencies, state });
    const second = await session.run({ request: realisticRequests.dependencies, state });

    assert.equal(first.receipt.resultHash, second.receipt.resultHash);
    assert.ok(first.receipt.newlyMaterializedBytes > 0);
    assert.equal(second.receipt.newlyMaterializedBytes, 0);
    assert.deepEqual(second.receipt.newlyMaterializedCapabilityIds, []);
    assert.equal(second.receipt.cacheBytesAfter, first.receipt.cacheBytesAfter);
  } finally {
    await session.close({ state });
  }
});

test("narrow warm Ignition cache stays smaller than eager warm cache", async () => {
  const state = buildWorkspaceState({ fileCount: 500 });
  const ignition = new IgnitionSession({ registry: buildRealisticRegistry(), mode: "ignition" });
  const eager = new IgnitionSession({ registry: buildRealisticRegistry(), mode: "eager" });
  try {
    const narrow = await ignition.run({ request: realisticRequests.lint, state });
    const full = await eager.run({ request: realisticRequests.lint, state });
    assert.deepEqual(narrow.result, full.result);
    assert.ok(narrow.receipt.cacheBytesAfter < full.receipt.cacheBytesAfter);
    assert.equal(narrow.receipt.cacheCapabilityIds.length, 1);
    assert.equal(full.receipt.cacheCapabilityIds.length, 7);
  } finally {
    await ignition.close({ state });
    await eager.close({ state });
  }
});

test("broad report removes the warm memory advantage because every body is relevant", async () => {
  const state = buildWorkspaceState({ fileCount: 500 });
  const ignition = new IgnitionSession({ registry: buildRealisticRegistry(), mode: "ignition" });
  const eager = new IgnitionSession({ registry: buildRealisticRegistry(), mode: "eager" });
  try {
    const a = await ignition.run({ request: realisticRequests.report, state });
    const b = await eager.run({ request: realisticRequests.report, state });
    assert.deepEqual(a.result, b.result);
    assert.equal(a.receipt.cacheBytesAfter, b.receipt.cacheBytesAfter);
    assert.deepEqual(a.receipt.cacheCapabilityIds, b.receipt.cacheCapabilityIds);
  } finally {
    await ignition.close({ state });
    await eager.close({ state });
  }
});

test("state change invalidates warm cache and rematerializes against new truth", async () => {
  const firstState = buildWorkspaceState({ fileCount: 300 });
  const secondState = buildWorkspaceState({ fileCount: 301 });
  const session = new IgnitionSession({ registry: buildRealisticRegistry(), mode: "ignition" });
  try {
    const first = await session.run({ request: realisticRequests.symbols, state: firstState });
    const second = await session.run({ request: realisticRequests.symbols, state: secondState });
    assert.ok(first.receipt.newlyMaterializedBytes > 0);
    assert.ok(second.receipt.newlyMaterializedBytes > 0);
    assert.notEqual(first.receipt.stateHash, second.receipt.stateHash);
  } finally {
    await session.close({ state: secondState });
  }
});
