import test from "node:test";
import assert from "node:assert/strict";

import { BudgetedRetentionSession } from "../src/budgeted-retention.js";
import { runDirectRealisticBaseline } from "../src/direct-realistic-baseline.js";
import { buildRealisticRegistry, buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";

async function assertMatchesDirect(session, request, state) {
  const run = await session.run({ request, state });
  const direct = await runDirectRealisticBaseline({ request, state, registry: buildRealisticRegistry() });
  assert.deepEqual(run.result, direct.result);
  assert.equal(run.receipt.resultHash, direct.receipt.resultHash);
  assert.ok(run.receipt.cacheBytesAfter <= session.maxCacheBytes);
  return run;
}

test("no-retention policy never keeps a derived body", async () => {
  const state = buildWorkspaceState({ fileCount: 500 });
  const session = new BudgetedRetentionSession({ registry: buildRealisticRegistry(), maxCacheBytes: 1_000_000, policy: "none" });
  try {
    const first = await assertMatchesDirect(session, realisticRequests.dependencies, state);
    const second = await assertMatchesDirect(session, realisticRequests.dependencies, state);
    assert.equal(first.receipt.retained, false);
    assert.equal(second.receipt.retained, false);
    assert.equal(first.receipt.cacheHit, false);
    assert.equal(second.receipt.cacheHit, false);
    assert.equal(session.cacheBytes, 0);
  } finally {
    await session.close({ state });
  }
});

test("LRU retention obeys a hard byte ceiling and emits deterministic evictions", async () => {
  const state = buildWorkspaceState({ fileCount: 1000 });
  const session = new BudgetedRetentionSession({ registry: buildRealisticRegistry(), maxCacheBytes: 20_000, policy: "lru" });
  try {
    const dependencies = await assertMatchesDirect(session, realisticRequests.dependencies, state);
    assert.ok(dependencies.receipt.retained);
    const symbols = await assertMatchesDirect(session, realisticRequests.symbols, state);
    assert.ok(session.cacheBytes <= 20_000);
    assert.ok(symbols.receipt.evicted.length >= 1);
    assert.equal(symbols.receipt.evicted[0].capabilityId, "workspace-dependency-index");
    assert.equal(symbols.receipt.evicted[0].reason, "budget");
  } finally {
    await session.close({ state });
  }
});

test("oversized bodies are used transiently instead of violating the cache budget", async () => {
  const state = buildWorkspaceState({ fileCount: 1000 });
  const session = new BudgetedRetentionSession({ registry: buildRealisticRegistry(), maxCacheBytes: 100_000, policy: "value" });
  try {
    const search = await assertMatchesDirect(session, realisticRequests.search, state);
    assert.equal(search.receipt.retained, false);
    assert.equal(search.receipt.cacheBytesAfter, 0);
    assert.equal(search.receipt.cacheHit, false);
  } finally {
    await session.close({ state });
  }
});

test("retained body produces a real warm cache hit without rematerialization", async () => {
  const state = buildWorkspaceState({ fileCount: 500 });
  const session = new BudgetedRetentionSession({ registry: buildRealisticRegistry(), maxCacheBytes: 100_000, policy: "value" });
  try {
    const first = await assertMatchesDirect(session, realisticRequests.dependencies, state);
    const second = await assertMatchesDirect(session, realisticRequests.dependencies, state);
    assert.equal(first.receipt.cacheHit, false);
    assert.ok(first.receipt.materializedBytes > 0);
    assert.equal(second.receipt.cacheHit, true);
    assert.equal(second.receipt.materializedBytes, 0);
  } finally {
    await session.close({ state });
  }
});

test("canonical state change invalidates the complete v0.07 budget cache", async () => {
  const firstState = buildWorkspaceState({ fileCount: 500 });
  const secondState = buildWorkspaceState({ fileCount: 501 });
  const session = new BudgetedRetentionSession({ registry: buildRealisticRegistry(), maxCacheBytes: 100_000, policy: "value" });
  try {
    await session.run({ request: realisticRequests.dependencies, state: firstState });
    const changed = await session.run({ request: realisticRequests.dependencies, state: secondState });
    assert.ok(changed.receipt.invalidatedForStateChange.length >= 1);
    assert.equal(changed.receipt.cacheHit, false);
  } finally {
    await session.close({ state: secondState });
  }
});
