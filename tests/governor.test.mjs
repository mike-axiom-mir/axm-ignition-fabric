import test from "node:test";
import assert from "node:assert/strict";

import { IgnitionGovernor } from "../src/ignition-governor.js";
import { runDirectRealisticBaseline } from "../src/direct-realistic-baseline.js";
import { buildRealisticRegistry, buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";

function buildGovernor(options = {}) {
  return new IgnitionGovernor({
    registry: buildRealisticRegistry(),
    directRunner: runDirectRealisticBaseline,
    cacheBudgetBytes: 500_000,
    ...options,
  });
}

test("Governor learns a narrow route then promotes repeated work to warm Ignition", async () => {
  const state = buildWorkspaceState({ fileCount: 500 });
  const governor = buildGovernor({ cacheBudgetBytes: 100_000 });
  try {
    const first = await governor.run({ request: realisticRequests.dependencies, state });
    const second = await governor.run({ request: realisticRequests.dependencies, state });
    const third = await governor.run({ request: realisticRequests.dependencies, state });

    assert.equal(first.receipt.selectedMode, "direct-cold");
    assert.equal(second.receipt.selectedMode, "ignition-warm");
    assert.equal(third.receipt.selectedMode, "ignition-warm");
    assert.equal(second.executionReceipt.newlyMaterializedBytes > 0, true);
    assert.equal(third.executionReceipt.newlyMaterializedBytes, 0);
    assert.equal(first.receipt.resultHash, second.receipt.resultHash);
    assert.equal(second.receipt.resultHash, third.receipt.resultHash);
  } finally {
    await governor.close({ state });
  }
});

test("Governor chooses eager warm for a repeated broad route after measuring its body", async () => {
  const state = buildWorkspaceState({ fileCount: 500 });
  const governor = buildGovernor({ cacheBudgetBytes: 500_000 });
  try {
    const first = await governor.run({ request: realisticRequests.report, state });
    const second = await governor.run({ request: realisticRequests.report, state });
    const third = await governor.run({ request: realisticRequests.report, state });

    assert.equal(first.receipt.selectedMode, "ignition-cold");
    assert.equal(second.receipt.selectedMode, "eager-warm");
    assert.equal(third.receipt.selectedMode, "eager-warm");
    assert.equal(second.receipt.retainedCacheCapabilityIds.length, 7);
    assert.deepEqual(first.result, second.result);
    assert.deepEqual(second.result, third.result);
  } finally {
    await governor.close({ state });
  }
});

test("Governor refuses warm retention when measured route exceeds cache budget", async () => {
  const state = buildWorkspaceState({ fileCount: 500 });
  const governor = buildGovernor({ cacheBudgetBytes: 20_000 });
  try {
    const first = await governor.run({ request: realisticRequests.search, state });
    const second = await governor.run({ request: realisticRequests.search, state });

    assert.equal(first.receipt.selectedMode, "direct-cold");
    assert.equal(second.receipt.selectedMode, "direct-cold");
    assert.equal(second.receipt.reason, "route-exceeds-cache-budget");
    assert.equal(second.receipt.retainedCacheBytes, 0);
  } finally {
    await governor.close({ state });
  }
});

test("Governor keeps broad work cold when full body exceeds cache budget", async () => {
  const state = buildWorkspaceState({ fileCount: 500 });
  const governor = buildGovernor({ cacheBudgetBytes: 50_000 });
  try {
    const first = await governor.run({ request: realisticRequests.report, state });
    const second = await governor.run({ request: realisticRequests.report, state });

    assert.equal(first.receipt.selectedMode, "ignition-cold");
    assert.equal(second.receipt.selectedMode, "ignition-cold");
    assert.equal(second.receipt.reason, "route-exceeds-cache-budget");
  } finally {
    await governor.close({ state });
  }
});

test("Governor abandons warm retention when canonical state churn becomes high", async () => {
  const a = buildWorkspaceState({ fileCount: 300 });
  const b = buildWorkspaceState({ fileCount: 301 });
  const governor = buildGovernor({ cacheBudgetBytes: 100_000, stateChurnMinRuns: 2, stateChurnThreshold: 0.5 });
  try {
    const r1 = await governor.run({ request: realisticRequests.dependencies, state: a });
    const r2 = await governor.run({ request: realisticRequests.dependencies, state: b });
    const r3 = await governor.run({ request: realisticRequests.dependencies, state: a });
    const r4 = await governor.run({ request: realisticRequests.dependencies, state: b });

    assert.equal(r1.receipt.selectedMode, "direct-cold");
    assert.equal(r2.receipt.selectedMode, "ignition-warm");
    assert.equal(r3.receipt.selectedMode, "direct-cold");
    assert.equal(r3.receipt.reason, "state-churn-avoids-retention");
    assert.equal(r4.receipt.selectedMode, "direct-cold");
  } finally {
    await governor.close({ state: b });
  }
});

test("Once an eager cache is grounded, narrow work can reuse it instead of mode thrashing", async () => {
  const state = buildWorkspaceState({ fileCount: 500 });
  const governor = buildGovernor({ cacheBudgetBytes: 500_000 });
  try {
    await governor.run({ request: realisticRequests.report, state });
    const broadWarm = await governor.run({ request: realisticRequests.report, state });
    const narrow = await governor.run({ request: realisticRequests.lint, state });

    assert.equal(broadWarm.receipt.selectedMode, "eager-warm");
    assert.equal(narrow.receipt.selectedMode, "eager-warm");
    assert.equal(narrow.receipt.reason, "warm-cache-hit");
  } finally {
    await governor.close({ state });
  }
});

test("Governor result remains equal to direct deterministic baseline", async () => {
  const state = buildWorkspaceState({ fileCount: 500 });
  const governor = buildGovernor({ cacheBudgetBytes: 500_000 });
  try {
    for (const request of [realisticRequests.dependencies, realisticRequests.search, realisticRequests.report]) {
      const governed = await governor.run({ request, state });
      const direct = await runDirectRealisticBaseline({ request, state, registry: buildRealisticRegistry() });
      assert.deepEqual(governed.result, direct.result);
      assert.equal(governed.receipt.resultHash, direct.receipt.resultHash);
    }
  } finally {
    await governor.close({ state });
  }
});
