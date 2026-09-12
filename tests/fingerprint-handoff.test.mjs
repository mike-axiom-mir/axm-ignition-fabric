import test from "node:test";
import assert from "node:assert/strict";

import { hashValue } from "../src/ignition-core.js";
import { IgnitionGovernor } from "../src/ignition-governor.js";
import { runDirectRealisticBaseline } from "../src/direct-realistic-baseline.js";
import { buildRealisticRegistry, buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";

test("Governor computes one canonical fingerprint and selected paths reuse it", async () => {
  const state = buildWorkspaceState({ fileCount: 500 });
  const expected = hashValue(state);
  const governor = new IgnitionGovernor({
    registry: buildRealisticRegistry(),
    directRunner: runDirectRealisticBaseline,
    cacheBudgetBytes: 500_000,
  });

  try {
    const direct = await governor.run({ request: realisticRequests.dependencies, state });
    assert.equal(direct.receipt.selectedMode, "direct-cold");
    assert.equal(direct.receipt.canonicalFingerprintShared, true);
    assert.equal(direct.executionReceipt.stateHash, expected);
    assert.equal(direct.executionReceipt.stateFingerprintReused, true);

    const warm = await governor.run({ request: realisticRequests.dependencies, state });
    assert.equal(warm.receipt.selectedMode, "ignition-warm");
    assert.equal(warm.receipt.canonicalFingerprintShared, true);
    assert.equal(warm.executionReceipt.stateHash, expected);
    assert.equal(warm.executionReceipt.stateFingerprintReused, true);

    const broadGovernor = new IgnitionGovernor({
      registry: buildRealisticRegistry(),
      directRunner: runDirectRealisticBaseline,
      cacheBudgetBytes: 50_000,
    });
    try {
      const cold = await broadGovernor.run({ request: realisticRequests.report, state });
      assert.equal(cold.receipt.selectedMode, "ignition-cold");
      assert.equal(cold.receipt.canonicalFingerprintShared, true);
      assert.equal(cold.executionReceipt.stateHash, expected);
      assert.equal(cold.executionReceipt.stateFingerprintReused, true);
    } finally {
      await broadGovernor.close({ state });
    }
  } finally {
    await governor.close({ state });
  }
});
