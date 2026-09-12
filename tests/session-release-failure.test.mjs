import test from "node:test";
import assert from "node:assert/strict";

import { CapabilityRegistry, hashValue } from "../src/ignition-core.js";
import { IgnitionSession } from "../src/ignition-session.js";
import { createTransitionReceipt } from "../src/scoped-invalidation.js";

test("failed scoped release evicts the complete stale set before rejecting the transition", async () => {
  const before = { revision: 1 };
  const after = { revision: 2 };
  const materializations = new Map();
  const releaseCalls = [];
  let failStaleARelease = true;

  function capability(id, domain) {
    return {
      id,
      match: (request) => request.kind === "all",
      materialize: () => {
        materializations.set(id, (materializations.get(id) || 0) + 1);
        return {
          instance: { id, materialization: materializations.get(id) },
          allocatedBytes: 16,
        };
      },
      run: ({ runtime }) => ({ id: runtime.id, materialization: runtime.materialization }),
      release: () => {
        releaseCalls.push(id);
        if (id === "stale-a" && failStaleARelease) {
          throw new Error("synthetic release failure");
        }
      },
    };
  }

  const registry = new CapabilityRegistry([
    capability("keep", "other"),
    capability("stale-a", "changed"),
    capability("stale-b", "changed"),
  ]);
  const session = new IgnitionSession({
    registry,
    mode: "ignition",
    domainBindings: {
      keep: ["other"],
      "stale-a": ["changed"],
      "stale-b": ["changed"],
    },
  });

  try {
    await session.run({ request: { kind: "all" }, state: before });
    assert.deepEqual(session.cachedCapabilityIds, ["keep", "stale-a", "stale-b"]);

    const transitionReceipt = createTransitionReceipt({
      fromStateHash: hashValue(before),
      toStateHash: hashValue(after),
      changedDomains: ["changed"],
      evidence: { test: "partial-release-failure" },
    });

    await assert.rejects(
      session.applyTransition({ transitionReceipt, state: after }),
      (error) => {
        assert.equal(error.code, "AXM_SESSION_RELEASE_FAILED");
        assert.deepEqual(error.failedCapabilityIds, ["stale-a"]);
        assert.deepEqual(error.evictedCapabilityIds, ["stale-a", "stale-b"]);
        assert.deepEqual(error.releasedCapabilityIds, ["stale-b"]);
        return true;
      },
    );

    assert.deepEqual(releaseCalls, ["stale-b", "stale-a"]);
    assert.equal(session.stateHash, hashValue(before));
    assert.deepEqual(session.cachedCapabilityIds, ["keep"]);
    assert.equal(session.cacheBytes, 16);

    // Once the external release problem is repaired, the same canonical transition can
    // advance from the unchanged old truth. The stale bodies are then rebuilt rather
    // than silently reused from the failed release attempt.
    failStaleARelease = false;
    const applied = await session.applyTransition({ transitionReceipt, state: after });
    assert.equal(applied.resultingStateHash, hashValue(after));
    assert.deepEqual(applied.invalidatedCapabilityIds, []);
    assert.deepEqual(applied.retainedCapabilityIds, ["keep"]);

    const rerun = await session.run({ request: { kind: "all" }, state: after });
    assert.deepEqual(rerun.receipt.newlyMaterializedCapabilityIds, ["stale-a", "stale-b"]);
    assert.equal(materializations.get("keep"), 1);
    assert.equal(materializations.get("stale-a"), 2);
    assert.equal(materializations.get("stale-b"), 2);
  } finally {
    failStaleARelease = false;
    await session.close({ state: after });
  }
});
