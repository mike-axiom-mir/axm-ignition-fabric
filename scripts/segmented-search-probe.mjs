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

function peakObservation(entries, field) {
  const baseline = entries[0].snapshot[field];
  let best = entries[0];
  for (const entry of entries) {
    if (entry.snapshot[field] > best.snapshot[field]) best = entry;
  }
  return {
    phase: best.phase,
    capabilityId: best.capabilityId,
    liveBodyBytes: best.liveBodyBytes,
    absoluteBytes: best.snapshot[field],
    deltaBytes: Math.max(0, best.snapshot[field] - baseline),
  };
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
    const entries = run.receipt.resourceSnapshots;
    const arrayBufferPeak = peakObservation(entries, "arrayBuffers");
    const externalPeak = peakObservation(entries, "external");
    const rssPeak = peakObservation(entries, "rss");
    const heapPeak = peakObservation(entries, "heapUsed");
    out.measuredPeakArrayBufferDeltaBytes = arrayBufferPeak.deltaBytes;
    out.measuredPeakExternalDeltaBytes = externalPeak.deltaBytes;
    out.measuredPeakRssDeltaBytes = rssPeak.deltaBytes;
    out.measuredPeakHeapUsedDeltaBytes = heapPeak.deltaBytes;
    out.peakObservations = { arrayBuffers: arrayBufferPeak, external: externalPeak, rss: rssPeak, heapUsed: heapPeak };
    out.measurementBoundary = "Fresh --expose-gc Node process. Forced-GC checkpoints are used only in memory mode. ArrayBuffer delta is the primary backing-store observation. Peak phase attribution is recorded so hidden construction/allocator peaks are not confused with declared reachable runtime-body bytes.";
  } else {
    out.timingBoundary = "Fresh Node process without forced-GC instrumentation. Timer wraps one complete zero-retention streamed report run; fixture and state-fingerprint construction are excluded.";
  }

  console.log(JSON.stringify(out));
} finally {
  await session.close({ state });
}
