import test from "node:test";
import assert from "node:assert/strict";

import { IgnitionSession } from "../src/ignition-session.js";
import { runDirectRealisticBaseline } from "../src/direct-realistic-baseline.js";
import { buildRealisticRegistry, buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";
import {
  changeWorkspaceImportTarget,
  changeWorkspacePath,
  createWorkspaceTransitionReceipt,
  diffWorkspaceDomains,
  resolveRealisticInvalidation,
} from "../src/realistic-mutations.js";

async function warmReport(state) {
  const session = new IgnitionSession({ registry: buildRealisticRegistry(), mode: "ignition" });
  const run = await session.run({ request: realisticRequests.report, state });
  assert.equal(run.receipt.cacheCapabilityIds.length, 7);
  return session;
}

test("path-only workspace change maps to metadata domain only", () => {
  const before = buildWorkspaceState({ fileCount: 500 });
  const after = changeWorkspacePath(before, 17, ".renamed");
  assert.deepEqual(diffWorkspaceDomains(before, after), ["metadata"]);
});

test("same-width import target change maps only to import and content-hash domains", () => {
  const before = buildWorkspaceState({ fileCount: 500 });
  const after = changeWorkspaceImportTarget(before, 417, 418, 419);
  assert.deepEqual(diffWorkspaceDomains(before, after), ["content-hash", "imports"]);
});

test("scoped path transition retains six warm bodies and rematerializes metadata only", async () => {
  const before = buildWorkspaceState({ fileCount: 500 });
  const after = changeWorkspacePath(before, 17, ".renamed");
  const transition = createWorkspaceTransitionReceipt(before, after);
  const session = await warmReport(before);
  try {
    const resolution = resolveRealisticInvalidation({
      transitionReceipt: transition,
      cachedCapabilityIds: session.cachedCapabilityIds,
    });
    assert.deepEqual(resolution.invalidatedCapabilityIds, ["workspace-metadata-index"]);

    const applied = await session.applyTransition({
      transitionReceipt: transition,
      invalidatedCapabilityIds: resolution.invalidatedCapabilityIds,
      state: after,
    });
    assert.equal(applied.retainedCapabilityIds.length, 6);
    assert.deepEqual(applied.releasedCapabilityIds, ["workspace-metadata-index"]);

    const scoped = await session.run({
      request: realisticRequests.report,
      state: after,
      stateFingerprint: transition.toStateHash,
    });
    assert.deepEqual(scoped.receipt.newlyMaterializedCapabilityIds, ["workspace-metadata-index"]);

    const direct = await runDirectRealisticBaseline({ request: realisticRequests.report, state: after });
    assert.deepEqual(scoped.result, direct.result);
    assert.equal(scoped.receipt.resultHash, direct.receipt.resultHash);
  } finally {
    await session.close({ state: after });
  }
});

test("scoped import transition invalidates dependency and duplicate bodies only", async () => {
  const before = buildWorkspaceState({ fileCount: 500 });
  const after = changeWorkspaceImportTarget(before, 417, 418, 419);
  const transition = createWorkspaceTransitionReceipt(before, after);
  const session = await warmReport(before);
  try {
    const resolution = resolveRealisticInvalidation({ transitionReceipt: transition, cachedCapabilityIds: session.cachedCapabilityIds });
    assert.deepEqual(resolution.invalidatedCapabilityIds, ["workspace-dependency-index", "workspace-duplicate-index"]);
    await session.applyTransition({ transitionReceipt: transition, invalidatedCapabilityIds: resolution.invalidatedCapabilityIds, state: after });

    const scoped = await session.run({ request: realisticRequests.report, state: after, stateFingerprint: transition.toStateHash });
    assert.deepEqual(scoped.receipt.newlyMaterializedCapabilityIds, ["workspace-dependency-index", "workspace-duplicate-index"]);

    const changedDependency = await session.run({ request: { kind: "dependencies", fileId: 417 }, state: after, stateFingerprint: transition.toStateHash });
    assert.deepEqual(changedDependency.result["workspace-dependency-index"].targets, [419, 424, 448]);

    const direct = await runDirectRealisticBaseline({ request: realisticRequests.report, state: after });
    assert.deepEqual(scoped.result, direct.result);
  } finally {
    await session.close({ state: after });
  }
});

test("unreceipted canonical state change falls back to full warm-cache invalidation", async () => {
  const before = buildWorkspaceState({ fileCount: 500 });
  const after = changeWorkspacePath(before, 17, ".renamed");
  const session = await warmReport(before);
  try {
    const run = await session.run({ request: realisticRequests.report, state: after });
    assert.equal(run.receipt.fallbackInvalidation?.reason, "unreceipted-state-change");
    assert.equal(run.receipt.fallbackInvalidation?.releasedCapabilityIds.length, 7);
    assert.equal(run.receipt.newlyMaterializedCapabilityIds.length, 7);
  } finally {
    await session.close({ state: after });
  }
});

test("transition receipt cannot be applied to the wrong canonical base", async () => {
  const before = buildWorkspaceState({ fileCount: 300 });
  const other = buildWorkspaceState({ fileCount: 301 });
  const after = changeWorkspacePath(before, 17, ".renamed");
  const transition = createWorkspaceTransitionReceipt(before, after);
  const session = await warmReport(other);
  try {
    await assert.rejects(
      session.applyTransition({ transitionReceipt: transition, invalidatedCapabilityIds: ["workspace-metadata-index"], state: after }),
      /fromStateHash mismatch/
    );
    assert.equal(session.cachedCapabilityIds.length, 7);
  } finally {
    await session.close({ state: other });
  }
});
