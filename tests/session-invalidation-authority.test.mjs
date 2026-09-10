import test from "node:test";
import assert from "node:assert/strict";

import { IgnitionSession } from "../src/ignition-session.js";
import { hashValue } from "../src/ignition-core.js";
import { runDirectRealisticBaseline } from "../src/direct-realistic-baseline.js";
import { buildRealisticRegistry, buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";
import {
  REALISTIC_DOMAIN_BINDINGS,
  changeWorkspaceImportTarget,
  createWorkspaceTransitionReceipt,
} from "../src/realistic-mutations.js";

async function warmReport(state, domainBindings = REALISTIC_DOMAIN_BINDINGS) {
  const session = new IgnitionSession({
    registry: buildRealisticRegistry(),
    mode: "ignition",
    domainBindings,
  });
  const run = await session.run({ request: realisticRequests.report, state });
  assert.equal(run.receipt.cacheCapabilityIds.length, 7);
  return session;
}

test("session-owned domain bindings reject caller under-invalidation before state advances", async () => {
  const before = buildWorkspaceState({ fileCount: 500 });
  const after = changeWorkspaceImportTarget(before, 417, 418, 419);
  const transition = createWorkspaceTransitionReceipt(before, after);
  const session = await warmReport(before);
  const cachedBefore = session.cachedCapabilityIds;

  try {
    await assert.rejects(
      session.applyTransition({
        transitionReceipt: transition,
        invalidatedCapabilityIds: [],
        state: after,
      }),
      /invalidatedCapabilityIds mismatch session domain bindings/,
    );

    assert.equal(session.stateHash, hashValue(before));
    assert.deepEqual(session.cachedCapabilityIds, cachedBefore);

    const applied = await session.applyTransition({ transitionReceipt: transition, state: after });
    assert.equal(applied.invalidationAuthority, "SESSION_DOMAIN_BINDINGS");
    assert.deepEqual(applied.releasedCapabilityIds, [
      "workspace-dependency-index",
      "workspace-duplicate-index",
    ]);

    const scoped = await session.run({
      request: { kind: "dependencies", fileId: 417 },
      state: after,
      stateFingerprint: transition.toStateHash,
    });
    assert.deepEqual(scoped.result["workspace-dependency-index"].targets, [419, 424, 448]);

    const direct = await runDirectRealisticBaseline({
      request: { kind: "dependencies", fileId: 417 },
      state: after,
      registry: buildRealisticRegistry(),
      stateFingerprint: transition.toStateHash,
    });
    assert.deepEqual(scoped.result, direct.result);
  } finally {
    await session.close({ state: after });
  }
});

test("transition without domain bindings falls back to full warm-cache invalidation", async () => {
  const before = buildWorkspaceState({ fileCount: 300 });
  const after = changeWorkspaceImportTarget(before, 217, 218, 219);
  const transition = createWorkspaceTransitionReceipt(before, after);
  const session = await warmReport(before, null);

  try {
    const applied = await session.applyTransition({ transitionReceipt: transition, state: after });
    assert.equal(applied.invalidationAuthority, "FULL_CACHE_FALLBACK_NO_DOMAIN_BINDINGS");
    assert.equal(applied.releasedCapabilityIds.length, 7);
    assert.deepEqual(applied.retainedCapabilityIds, []);
    assert.equal(session.stateHash, transition.toStateHash);
  } finally {
    await session.close({ state: after });
  }
});

test("unbound session refuses a caller-supplied partial invalidation list", async () => {
  const before = buildWorkspaceState({ fileCount: 300 });
  const after = changeWorkspaceImportTarget(before, 217, 218, 219);
  const transition = createWorkspaceTransitionReceipt(before, after);
  const session = await warmReport(before, null);
  const cachedBefore = session.cachedCapabilityIds;

  try {
    await assert.rejects(
      session.applyTransition({
        transitionReceipt: transition,
        invalidatedCapabilityIds: ["workspace-dependency-index"],
        state: after,
      }),
      /scoped invalidation requires session domainBindings/,
    );
    assert.equal(session.stateHash, hashValue(before));
    assert.deepEqual(session.cachedCapabilityIds, cachedBefore);
  } finally {
    await session.close({ state: before });
  }
});
