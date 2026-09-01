import { IgnitionSession } from "../src/ignition-session.js";
import { runDirectRealisticBaseline } from "../src/direct-realistic-baseline.js";
import { buildRealisticRegistry, buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";
import {
  changeWorkspaceImportTarget,
  changeWorkspacePath,
  createWorkspaceTransitionReceipt,
  resolveRealisticInvalidation,
} from "../src/realistic-mutations.js";

const fileCount = 2500;

function buildPathSequence() {
  const states = [buildWorkspaceState({ fileCount })];
  const ids = [17, 37, 57, 77, 97];
  for (let i = 0; i < ids.length; i += 1) {
    states.push(changeWorkspacePath(states.at(-1), ids[i], `.r${i + 1}`));
  }
  return states;
}

function buildImportSequence() {
  const states = [buildWorkspaceState({ fileCount })];
  const ids = [417, 518, 619, 720];
  for (const id of ids) {
    states.push(changeWorkspaceImportTarget(states.at(-1), id, id + 1, id + 2));
  }
  return states;
}

async function runSequence({ strategy, states }) {
  const registry = buildRealisticRegistry();
  const session = new IgnitionSession({ registry, mode: "ignition" });
  const transitions = [];
  let allEquivalent = true;
  let totalWallMs = 0;
  let totalReleasedBytes = 0;
  let totalRematerializedBytes = 0;

  try {
    const initial = await session.run({ request: realisticRequests.report, state: states[0] });
    if (initial.receipt.cacheCapabilityIds.length !== 7) throw new Error("initial report did not warm full body");

    for (let i = 1; i < states.length; i += 1) {
      const before = states[i - 1];
      const after = states[i];
      const transitionReceipt = createWorkspaceTransitionReceipt(before, after);
      const started = performance.now();
      let transitionApply = null;

      if (strategy === "scoped") {
        const resolution = resolveRealisticInvalidation({
          transitionReceipt,
          cachedCapabilityIds: session.cachedCapabilityIds,
        });
        transitionApply = await session.applyTransition({
          transitionReceipt,
          invalidatedCapabilityIds: resolution.invalidatedCapabilityIds,
          state: after,
        });
      }

      const run = await session.run({
        request: realisticRequests.report,
        state: after,
        stateFingerprint: transitionReceipt.toStateHash,
      });
      const wallMs = performance.now() - started;
      totalWallMs += wallMs;

      const releasedBytes = strategy === "scoped"
        ? transitionApply.releasedBytes
        : run.receipt.fallbackInvalidation?.releasedBytes || 0;
      totalReleasedBytes += releasedBytes;
      totalRematerializedBytes += run.receipt.newlyMaterializedBytes;

      const direct = await runDirectRealisticBaseline({
        request: realisticRequests.report,
        state: after,
        registry: buildRealisticRegistry(),
        stateFingerprint: transitionReceipt.toStateHash,
      });
      if (run.receipt.resultHash !== direct.receipt.resultHash) allEquivalent = false;

      transitions.push({
        index: i,
        changedDomains: transitionReceipt.changedDomains,
        releasedCapabilityIds: strategy === "scoped"
          ? transitionApply.releasedCapabilityIds
          : run.receipt.fallbackInvalidation?.releasedCapabilityIds || [],
        releasedBytes,
        rematerializedCapabilityIds: run.receipt.newlyMaterializedCapabilityIds,
        rematerializedBytes: run.receipt.newlyMaterializedBytes,
        retainedCacheBytesAfter: run.receipt.cacheBytesAfter,
        resultHash: run.receipt.resultHash,
        wallMs,
      });
    }

    return {
      strategy,
      allEquivalent,
      transitionCount: transitions.length,
      totalWallMs,
      totalReleasedBytes,
      totalRematerializedBytes,
      finalCacheBytes: session.cacheBytes,
      transitions,
    };
  } finally {
    await session.close({ state: states.at(-1) });
  }
}

let failed = false;
for (const [name, states] of [["path-only", buildPathSequence()], ["import-target", buildImportSequence()]]) {
  const full = await runSequence({ strategy: "full", states });
  const scoped = await runSequence({ strategy: "scoped", states });
  const result = {
    schema: "axm.ignition-scoped-invalidation-benchmark/v0.06",
    name,
    fileCount,
    transitionCount: states.length - 1,
    equivalent: full.allEquivalent && scoped.allEquivalent,
    fullInvalidation: {
      totalWallMs: full.totalWallMs,
      totalReleasedBytes: full.totalReleasedBytes,
      totalRematerializedBytes: full.totalRematerializedBytes,
      transitions: full.transitions,
    },
    scopedInvalidation: {
      totalWallMs: scoped.totalWallMs,
      totalReleasedBytes: scoped.totalReleasedBytes,
      totalRematerializedBytes: scoped.totalRematerializedBytes,
      transitions: scoped.transitions,
    },
    saved: {
      rematerializedBytes: full.totalRematerializedBytes - scoped.totalRematerializedBytes,
      releasedBytes: full.totalReleasedBytes - scoped.totalReleasedBytes,
    },
    timingBoundary: "Transition receipt generation is upstream and excluded; measured wall time includes cache invalidation/release plus the first report run on new canonical state.",
  };
  console.log(JSON.stringify(result));
  if (!result.equivalent) failed = true;
  if (!(result.saved.rematerializedBytes > 0)) failed = true;
  if (name === "path-only" && !scoped.transitions.every((entry) => entry.rematerializedCapabilityIds.length === 1 && entry.rematerializedCapabilityIds[0] === "workspace-metadata-index")) failed = true;
  if (name === "import-target" && !scoped.transitions.every((entry) => JSON.stringify(entry.rematerializedCapabilityIds) === JSON.stringify(["workspace-dependency-index", "workspace-duplicate-index"]))) failed = true;
}

if (failed) process.exitCode = 1;
