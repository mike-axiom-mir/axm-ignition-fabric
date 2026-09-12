import test from "node:test";
import assert from "node:assert/strict";

import { compareEquivalentRuns, executeIgnitionRun } from "../src/ignition-core.js";
import { buildDemoRegistry, demoRequests } from "../src/demo-capabilities.js";

const state = { answer: 42 };

async function runPair(request) {
  const registry = buildDemoRegistry();
  const eager = await executeIgnitionRun({ registry, request, state, mode: "eager" });
  const ignition = await executeIgnitionRun({ registry, request, state, mode: "ignition" });
  return { eager, ignition };
}

test("eager and ignition execute the same relevant capability closure", async () => {
  const { eager, ignition } = await runPair(demoRequests.numbers);
  assert.deepEqual(eager.result, ignition.result);
  assert.deepEqual(eager.receipt.executedCapabilityIds, ignition.receipt.executedCapabilityIds);
  assert.equal(eager.receipt.resultHash, ignition.receipt.resultHash);
});

test("ignition materially reduces the real materialized workset for a narrow request", async () => {
  const { eager, ignition } = await runPair(demoRequests.numbers);
  assert.ok(ignition.receipt.materializedCount < eager.receipt.materializedCount);
  assert.ok(ignition.receipt.actualMaterializedBytes < eager.receipt.actualMaterializedBytes);
  assert.deepEqual(ignition.receipt.materializedCapabilityIds, ["normalize-numbers", "sum-numbers"]);
  assert.equal(ignition.receipt.actualMaterializedBytes, 3 * 1024 * 1024);
});

test("materialization receipts account for the actual allocated body sizes", async () => {
  const { eager } = await runPair(demoRequests.lookup);
  const summed = eager.receipt.materializationReceipts.reduce((total, receipt) => total + receipt.allocatedBytes, 0);
  assert.equal(eager.receipt.actualMaterializedBytes, summed);
  assert.equal(eager.receipt.materializationReceipts.length, eager.receipt.materializedCount);
});

test("matched dependencies are pulled into the materialized workset", async () => {
  const { ignition } = await runPair(demoRequests.text);
  assert.deepEqual(ignition.receipt.materializedCapabilityIds, ["count-tokens", "tokenize-text"]);
  assert.equal(ignition.result["count-tokens"], 4);
});

test("the irrelevant heavy capability stays dormant unless directly requested", async () => {
  const narrow = await executeIgnitionRun({
    registry: buildDemoRegistry(),
    request: demoRequests.lookup,
    state,
    mode: "ignition",
  });
  assert.equal(narrow.receipt.materializedCapabilityIds.includes("irrelevant-heavy-capability"), false);

  const heavy = await executeIgnitionRun({
    registry: buildDemoRegistry(),
    request: demoRequests.heavy,
    state,
    mode: "ignition",
  });
  assert.equal(heavy.receipt.materializedCapabilityIds.includes("irrelevant-heavy-capability"), true);
  assert.equal(heavy.receipt.actualMaterializedBytes, 16 * 1024 * 1024);
});

test("same request and state produce stable result hashes", async () => {
  const a = await executeIgnitionRun({
    registry: buildDemoRegistry(),
    request: demoRequests.mixed,
    state,
    mode: "ignition",
  });
  const b = await executeIgnitionRun({
    registry: buildDemoRegistry(),
    request: demoRequests.mixed,
    state,
    mode: "ignition",
  });
  assert.equal(a.receipt.resultHash, b.receipt.resultHash);
});

test("comparison helper proves equivalent results with a smaller materialized body", async () => {
  const { eager, ignition } = await runPair(demoRequests.lookup);
  const comparison = compareEquivalentRuns(eager, ignition);
  assert.equal(comparison.equivalent, true);
  assert.equal(comparison.executedCountDelta, 0);
  assert.ok(comparison.materializedCountDelta > 0);
  assert.ok(comparison.estimatedWorkingSetDeltaBytes > 0);
  assert.ok(comparison.actualMaterializedDeltaBytes > 0);
});
