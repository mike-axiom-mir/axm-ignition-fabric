import { hashValue } from "../src/ignition-core.js";
import { REALISTIC_DOMAIN_BINDINGS } from "../src/realistic-mutations.js";
import { buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";
import { buildConstructionAwareSegmentedRegistry } from "../src/construction-aware-metadata.js";
import { StreamedWorksetSession } from "../src/streamed-workset-session.js";

const metadataMode = process.argv[2] || "encoder";
const target = process.argv[3] || "report";
const measureMode = process.argv[4] || "memory";
const fileCount = Number(process.argv[5] || 2500);
if (!["encoder", "scalar"].includes(metadataMode)) throw new Error("metadata mode must be encoder or scalar");
if (!["metadata", "report"].includes(target)) throw new Error("target must be metadata or report");
if (!["memory", "timing"].includes(measureMode)) throw new Error("measure mode must be memory or timing");

const state = buildWorkspaceState({ fileCount });
const stateFingerprint = hashValue(state);
const request = target === "metadata" ? { kind: "metadata" } : realisticRequests.report;
const session = new StreamedWorksetSession({
  registry: buildConstructionAwareSegmentedRegistry({ segmentBits: 6, metadataMode }),
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

function peakDelta(rows, field) {
  const baseline = rows[0].snapshot[field];
  const peak = Math.max(...rows.map((row) => row.snapshot[field]));
  return Math.max(0, peak - baseline);
}

function peakSites(rows, field) {
  const peak = Math.max(...rows.map((row) => row.snapshot[field]));
  return rows
    .filter((row) => row.snapshot[field] === peak)
    .map((row) => ({ phase: row.phase, capabilityId: row.capabilityId }));
}

try {
  const started = performance.now();
  const run = await session.run({
    request,
    state,
    stateFingerprint,
    resourceProbe: measureMode === "memory" ? () => memorySnapshot() : null,
  });
  const wallMs = performance.now() - started;
  const metadataReceipt = run.receipt.materializationReceipts.find((entry) => entry.capabilityId === "workspace-metadata-index");
  if (!metadataReceipt) throw new Error("metadata materialization receipt missing");

  const out = {
    schema: "axm.ignition-construction-lifetime-probe/v0.14",
    metadataMode,
    target,
    measureMode,
    fileCount,
    resultHash: run.receipt.resultHash,
    metadataBodyBytes: metadataReceipt.allocatedBytes,
    totalMaterializedBytes: run.receipt.newlyMaterializedBytes,
    declaredPeakLiveBodyBytes: run.receipt.peakLiveBodyBytes,
    wallMs,
  };

  if (measureMode === "memory") {
    const rows = run.receipt.resourceSnapshots;
    out.measuredPeakArrayBufferDeltaBytes = peakDelta(rows, "arrayBuffers");
    out.measuredPeakExternalDeltaBytes = peakDelta(rows, "external");
    out.measuredPeakRssDeltaBytes = peakDelta(rows, "rss");
    out.measuredPeakHeapUsedDeltaBytes = peakDelta(rows, "heapUsed");
    out.arrayBufferPeakSites = peakSites(rows, "arrayBuffers");
    out.measurementBoundary = "Fresh --expose-gc Node process. Fixture and state fingerprint are created before the first resource snapshot. Each streamed lifecycle snapshot forces GC. ArrayBuffer delta is the primary construction-lifetime observation.";
  } else {
    out.timingBoundary = "Fresh Node process without forced-GC instrumentation. Timer wraps one complete zero-retention session.run. Fixture and state-fingerprint construction are excluded.";
  }

  console.log(JSON.stringify(out));
} finally {
  await session.close({ state });
}
