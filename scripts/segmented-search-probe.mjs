import { hashValue } from "../src/ignition-core.js";
import { REALISTIC_DOMAIN_BINDINGS } from "../src/realistic-mutations.js";
import { buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";
import { buildSegmentedRealisticRegistry } from "../src/segmented-search.js";
import { StreamedWorksetSession } from "../src/streamed-workset-session.js";

const mode = process.argv[2] || "timing";
const segmentBits = Number(process.argv[3] || 0);
const fileCount = Number(process.argv[4] || 2500);
if (!["memory", "timing"].includes(mode)) throw new Error("mode must be memory or timing");

const state = buildWorkspaceState({ fileCount });
const stateFingerprint = hashValue(state);
const session = new StreamedWorksetSession({
  registry: buildSegmentedRealisticRegistry({ segmentBits }),
  maxCacheBytes: 0,
  policy: "none",
  domainBindings: REALISTIC_DOMAIN_BINDINGS,
});

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

try {
  const started = performance.now();
  const run = await session.run({
    request: realisticRequests.report,
    state,
    stateFingerprint,
    resourceProbe: mode === "memory" ? () => memorySnapshot() : null,
  });
  const wallMs = performance.now() - started;
  const searchReceipt = run.receipt.materializationReceipts.find((entry) => entry.capabilityId === "workspace-search-index");
  if (!searchReceipt) throw new Error("segmented search materialization receipt missing");

  const out = {
    schema: "axm.ignition-segmented-search-probe/v0.13",
    mode,
    segmentBits,
    segmentCount: 2 ** segmentBits,
    fileCount,
    resultHash: run.receipt.resultHash,
    totalMaterializedBytes: run.receipt.newlyMaterializedBytes,
    searchMaterializedBytes: searchReceipt.allocatedBytes,
    declaredPeakLiveBodyBytes: run.receipt.peakLiveBodyBytes,
    wallMs,
    executionOrder: run.receipt.executionOrder,
    cacheBytesAfter: run.receipt.cacheBytesAfter,
  };

  if (mode === "memory") {
    const snapshots = run.receipt.resourceSnapshots.map((entry) => entry.snapshot);
    out.measuredPeakArrayBufferDeltaBytes = peakDelta(snapshots, "arrayBuffers");
    out.measuredPeakExternalDeltaBytes = peakDelta(snapshots, "external");
    out.measuredPeakRssDeltaBytes = peakDelta(snapshots, "rss");
    out.measuredPeakHeapUsedDeltaBytes = peakDelta(snapshots, "heapUsed");
    out.measurementBoundary = "Fresh --expose-gc Node process. Forced-GC checkpoints are used only in memory mode. ArrayBuffer delta is the primary typed-array backing-store observation; heap/external/RSS remain secondary process metrics.";
  } else {
    out.timingBoundary = "Fresh Node process without forced-GC instrumentation. Timer wraps one complete zero-retention streamed report run; fixture and state-fingerprint construction are excluded.";
  }

  console.log(JSON.stringify(out));
} finally {
  await session.close({ state });
}
