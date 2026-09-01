import v8 from "node:v8";
import { hashValueMonolithic } from "../src/ignition-core.js";
import { REALISTIC_DOMAIN_BINDINGS } from "../src/realistic-mutations.js";
import { buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";
import { buildConstructionAwareSegmentedRegistry, utf8ByteLengthScalar } from "../src/construction-aware-metadata.js";
import { StreamedWorksetSession } from "../src/streamed-workset-session.js";

const fileCount = Number(process.argv[2] || 2500);
if (!Number.isInteger(fileCount) || fileCount <= 0) throw new Error("fileCount must be a positive integer");
if (typeof global.gc !== "function") throw new Error("v0.15 residual attribution requires --expose-gc");

const MEMORY_FIELDS = Object.freeze([
  "rss",
  "heapTotal",
  "heapUsed",
  "external",
  "arrayBuffers",
  "v8MallocedMemory",
]);

function memorySnapshot() {
  global.gc();
  const memory = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  return {
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    v8MallocedMemory: heap.malloced_memory,
  };
}

const stages = [];
function checkpoint(name) {
  const memory = memorySnapshot();
  stages.push({ name, memory });
  return memory;
}

function clonePeakState(memory, phase = "pre-run", capabilityId = null, liveBodyBytes = 0) {
  const values = {};
  const sites = {};
  for (const field of MEMORY_FIELDS) {
    values[field] = memory[field];
    sites[field] = [{ phase, capabilityId, liveBodyBytes }];
  }
  return { values, sites };
}

function observePeak(peak, details) {
  const memory = memorySnapshot();
  for (const field of MEMORY_FIELDS) {
    if (memory[field] > peak.values[field]) {
      peak.values[field] = memory[field];
      peak.sites[field] = [{
        phase: details.phase,
        capabilityId: details.capabilityId,
        liveBodyBytes: details.liveBodyBytes,
      }];
    } else if (memory[field] === peak.values[field]) {
      peak.sites[field].push({
        phase: details.phase,
        capabilityId: details.capabilityId,
        liveBodyBytes: details.liveBodyBytes,
      });
    }
  }
  return null;
}

checkpoint("boot-modules-loaded");

let registry = buildConstructionAwareSegmentedRegistry({ segmentBits: 6, metadataMode: "scalar" });
checkpoint("registry-created");

let session = new StreamedWorksetSession({
  registry,
  maxCacheBytes: 0,
  policy: "none",
  domainBindings: REALISTIC_DOMAIN_BINDINGS,
});
checkpoint("session-created");

let state = buildWorkspaceState({ fileCount });
const canonicalStateFacts = {
  fileCount: state.files.length,
  packageCount: state.packageCount,
  sourceCharacters: state.files.reduce((sum, file) => sum + file.content.length, 0),
  sourceUtf8Bytes: state.files.reduce((sum, file) => sum + utf8ByteLengthScalar(file.content), 0),
};
checkpoint("canonical-state-created");

let stateFingerprint = hashValueMonolithic(state);
const preRunMemory = checkpoint("state-fingerprint-retained");
const runPeak = clonePeakState(preRunMemory);

let run = await session.run({
  request: realisticRequests.report,
  state,
  stateFingerprint,
  resourceProbe: (details) => observePeak(runPeak, details),
});
checkpoint("run-result-retained");

const logicalRun = {
  resultHash: run.receipt.resultHash,
  totalMaterializedBytes: run.receipt.newlyMaterializedBytes,
  declaredPeakLiveBodyBytes: run.receipt.peakLiveBodyBytes,
  cacheBytesAfter: run.receipt.cacheBytesAfter,
  cacheCapabilityIds: run.receipt.cacheCapabilityIds,
  executionOrder: run.receipt.executionOrder,
  resourceSnapshotsStoredInReceipt: run.receipt.resourceSnapshots.length,
};

await session.close({ state });
checkpoint("session-closed-result-retained");

run = null;
checkpoint("run-result-dropped");

stateFingerprint = null;
checkpoint("fingerprint-variable-dropped");

state = null;
checkpoint("canonical-state-dropped");

session = null;
registry = null;
checkpoint("framework-objects-dropped");

const preRunStage = stages.find((stage) => stage.name === "state-fingerprint-retained");
const runPeakDeltaFromPreRun = Object.fromEntries(
  MEMORY_FIELDS.map((field) => [field, runPeak.values[field] - preRunStage.memory[field]])
);

console.log(JSON.stringify({
  schema: "axm.ignition-whole-process-residual-probe/v0.15",
  fileCount,
  memoryFields: MEMORY_FIELDS,
  canonicalStateFacts,
  logicalRun,
  stages,
  runPeak: {
    absolute: runPeak.values,
    deltaFromPreRun: runPeakDeltaFromPreRun,
    sites: runPeak.sites,
  },
  measurementBoundary: "One fresh Node process with --expose-gc. Every checkpoint and streamed run peak observation forces GC before reading process.memoryUsage()/v8 heap statistics. The v0.15 state-fingerprint stage is explicitly pinned to hashValueMonolithic after v0.17 core integration so historical evidence does not silently change semantics. Stages expose object lifetime boundaries; RSS, heap, external, and ArrayBuffer are separate overlapping envelopes and must not be summed as additive categories.",
  truthBoundary: "This probe measures one Node runtime, one deterministic 2,500-file fixture, one zero-retention 64-segment report, and one hosted process shape. Module/runtime baseline remains loaded for the process lifetime. Dropping references does not guarantee RSS pages are returned to the OS immediately.",
}));
