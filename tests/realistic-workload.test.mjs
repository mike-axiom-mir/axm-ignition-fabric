import test from "node:test";
import assert from "node:assert/strict";

import { executeIgnitionRun } from "../src/ignition-core.js";
import { buildRealisticRegistry, buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";

const state = buildWorkspaceState({ fileCount: 1200 });

async function pair(request) {
  const eager = await executeIgnitionRun({ registry: buildRealisticRegistry(), request, state, mode: "eager" });
  const ignition = await executeIgnitionRun({ registry: buildRealisticRegistry(), request, state, mode: "ignition" });
  return { eager, ignition };
}

test("real dependency query preserves exact results while materializing only its parsed index", async () => {
  const { eager, ignition } = await pair(realisticRequests.dependencies);
  assert.deepEqual(eager.result, ignition.result);
  assert.equal(eager.receipt.resultHash, ignition.receipt.resultHash);
  assert.deepEqual(ignition.receipt.executedCapabilityIds, ["workspace-dependency-index"]);
  assert.deepEqual(ignition.receipt.materializedCapabilityIds, ["workspace-dependency-index"]);
  assert.equal(eager.receipt.materializedCount, 7);
  assert.equal(ignition.receipt.materializedCount, 1);
  assert.ok(ignition.receipt.actualMaterializedBytes < eager.receipt.actualMaterializedBytes);
  assert.equal(ignition.result["workspace-dependency-index"].targets.length, 3);
});

test("search materialization builds a real token occurrence index", async () => {
  const run = await executeIgnitionRun({
    registry: buildRealisticRegistry(),
    request: realisticRequests.search,
    state,
    mode: "ignition",
  });
  assert.deepEqual(run.receipt.executedCapabilityIds, ["workspace-search-index"]);
  assert.ok(run.receipt.actualMaterializedBytes > 100_000);
  assert.ok(run.result["workspace-search-index"].occurrences > 0);
  assert.ok(run.result["workspace-search-index"].files > 0);
});

test("broad report is an honest no-savings case because every index is relevant", async () => {
  const { eager, ignition } = await pair(realisticRequests.report);
  assert.deepEqual(eager.result, ignition.result);
  assert.equal(eager.receipt.resultHash, ignition.receipt.resultHash);
  assert.equal(eager.receipt.materializedCount, 7);
  assert.equal(ignition.receipt.materializedCount, 7);
  assert.equal(eager.receipt.actualMaterializedBytes, ignition.receipt.actualMaterializedBytes);
  assert.equal(ignition.result["workspace-report-projection"].files, 1200);
});

test("deterministic fixture and index outputs replay exactly", async () => {
  const a = await executeIgnitionRun({ registry: buildRealisticRegistry(), request: realisticRequests.duplicates, state, mode: "ignition" });
  const b = await executeIgnitionRun({ registry: buildRealisticRegistry(), request: realisticRequests.duplicates, state, mode: "ignition" });
  assert.equal(a.receipt.resultHash, b.receipt.resultHash);
  assert.deepEqual(a.result, b.result);
  assert.ok(a.result["workspace-duplicate-index"].duplicateFiles > 1);
});
