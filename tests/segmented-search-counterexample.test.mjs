import test from "node:test";
import assert from "node:assert/strict";

import { executeIgnitionRun, hashValue } from "../src/ignition-core.js";
import { buildRealisticRegistry } from "../src/realistic-workload.js";
import { buildSegmentedRealisticRegistry } from "../src/segmented-search.js";

function concentratedState(fileCount = 600) {
  return {
    schema: "axm.ignition-concentrated-search-fixture/v0.13",
    fileCount,
    packageCount: 1,
    files: Array.from({ length: fileCount }, (_, id) => ({
      id,
      packageId: 0,
      language: "js",
      path: `same/file-${id}.js`,
      content: "same same same same same",
    })),
  };
}

test("segmentation cannot shrink a search body whose tokens all occupy one partition", async () => {
  const state = concentratedState();
  const request = { kind: "search", query: "same" };
  const stateFingerprint = hashValue(state);
  const whole = await executeIgnitionRun({
    registry: buildRealisticRegistry(),
    request,
    state,
    mode: "ignition",
    stateFingerprint,
  });
  const segmented = await executeIgnitionRun({
    registry: buildSegmentedRealisticRegistry({ segmentBits: 6 }),
    request,
    state,
    mode: "ignition",
    stateFingerprint,
  });
  assert.deepEqual(segmented.result, whole.result);
  assert.equal(segmented.receipt.actualMaterializedBytes, whole.receipt.actualMaterializedBytes);
});
