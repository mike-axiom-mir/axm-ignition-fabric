import { executeIgnitionRun, hashValue } from "../src/ignition-core.js";
import { BudgetedWorksetSession } from "../src/workset-session.js";
import { StreamedWorksetSession } from "../src/streamed-workset-session.js";
import { REALISTIC_DOMAIN_BINDINGS } from "../src/realistic-mutations.js";
import { buildRealisticRegistry, buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";

const mode = process.argv[2] || "streamed-memory";
const scenario = process.argv[3] || "report";
const fileCount = Number(process.argv[4] || 2500);
if (!["whole-memory", "streamed-memory", "whole-timing", "streamed-timing"].includes(mode)) {
  throw new Error("mode must be whole-memory, streamed-memory, whole-timing, or streamed-timing");
}
if (!["report", "single"].includes(scenario)) throw new Error("scenario must be report or single");

const state = buildWorkspaceState({ fileCount });
const stateFingerprint = hashValue(state);
const request = scenario === "report" ? realisticRequests.report : realisticRequests.dependencies;

function memorySnapshot() {
  if (typeof global.gc !== "function") throw new Error("memory mode requires --expose-gc");
  global.gc();
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

function peakDelta(snapshots, field) {
  const baseline = snapshots[0][field];
  const peak = Math.max(...snapshots.map((snapshot) => snapshot[field]));
  return Math.max(0, peak - baseline);
}

if (mode === "whole-memory") {
  const run = await executeIgnitionRun({
    registry: buildRealisticRegistry(),
    request,
    state,
    mode: "ignition",
    stateFingerprint,
    resourceProbe: () => memorySnapshot(),
  });
  const snapshots = [
    run.receipt.resourceSnapshots.beforeMaterialize,
    run.receipt.resourceSnapshots.afterMaterialize,
    run.receipt.resourceSnapshots.afterRelease,
  ].filter(Boolean);
  console.log(JSON.stringify({
    schema: "axm.ignition-streamed-peak-probe/v0.12",
    mode,
    scenario,
    fileCount,
    resultHash: run.receipt.resultHash,
    totalMaterializedBytes: run.receipt.actualMaterializedBytes,
    declaredPeakLiveBodyBytes: run.receipt.actualMaterializedBytes,
    measuredPeakArrayBufferDeltaBytes: peakDelta(snapshots, "arrayBuffers"),
    measuredPeakExternalDeltaBytes: peakDelta(snapshots, "external"),
    measuredPeakRssDeltaBytes: peakDelta(snapshots, "rss"),
    snapshots,
    measurementBoundary: "Fresh process. resourceProbe forces GC at before-materialize, after-materialize, and after-release checkpoints. ArrayBuffer delta is the primary physical backing-store observation; RSS/external are secondary allocator/process observations.",
  }));
} else if (mode === "streamed-memory") {
  const session = new StreamedWorksetSession({
    registry: buildRealisticRegistry(),
    maxCacheBytes: 0,
    policy: "none",
    domainBindings: REALISTIC_DOMAIN_BINDINGS,
  });
  try {
    const run = await session.run({
      request,
      state,
      stateFingerprint,
      resourceProbe: () => memorySnapshot(),
    });
    const snapshots = run.receipt.resourceSnapshots.map((entry) => entry.snapshot);
    console.log(JSON.stringify({
      schema: "axm.ignition-streamed-peak-probe/v0.12",
      mode,
      scenario,
      fileCount,
      resultHash: run.receipt.resultHash,
      totalMaterializedBytes: run.receipt.newlyMaterializedBytes,
      declaredPeakLiveBodyBytes: run.receipt.peakLiveBodyBytes,
      measuredPeakArrayBufferDeltaBytes: peakDelta(snapshots, "arrayBuffers"),
      measuredPeakExternalDeltaBytes: peakDelta(snapshots, "external"),
      measuredPeakRssDeltaBytes: peakDelta(snapshots, "rss"),
      snapshots,
      measurementBoundary: "Fresh process. resourceProbe forces GC at streamed lifecycle checkpoints after runtime references are materialized/released. ArrayBuffer delta is the primary physical backing-store observation; RSS/external are secondary allocator/process observations.",
    }));
  } finally {
    await session.close({ state });
  }
} else {
  const isStreamed = mode === "streamed-timing";
  const session = isStreamed
    ? new StreamedWorksetSession({
        registry: buildRealisticRegistry(),
        maxCacheBytes: 0,
        policy: "none",
        domainBindings: REALISTIC_DOMAIN_BINDINGS,
      })
    : new BudgetedWorksetSession({
        registry: buildRealisticRegistry(),
        maxCacheBytes: 0,
        policy: "none",
        domainBindings: REALISTIC_DOMAIN_BINDINGS,
      });
  try {
    const started = performance.now();
    const run = await session.run({ request, state, stateFingerprint });
    const wallMs = performance.now() - started;
    console.log(JSON.stringify({
      schema: "axm.ignition-streamed-peak-probe/v0.12",
      mode,
      scenario,
      fileCount,
      resultHash: run.receipt.resultHash,
      totalMaterializedBytes: isStreamed ? run.receipt.newlyMaterializedBytes : run.receipt.newlyMaterializedBytes,
      declaredPeakLiveBodyBytes: isStreamed ? run.receipt.peakLiveBodyBytes : run.receipt.closureBodyBytes,
      wallMs,
      executionOrder: run.receipt.executionOrder,
      timingBoundary: "Fresh process, normal execution without forced-GC instrumentation. Timer wraps one complete session.run call; fixture/state fingerprint creation and teardown are excluded.",
    }));
  } finally {
    await session.close({ state });
  }
}
