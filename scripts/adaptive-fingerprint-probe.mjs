import v8 from "node:v8";
import { fnv1a32, hashValueMonolithic, stableStringify } from "../src/ignition-core.js";
import {
  DEFAULT_ADAPTIVE_FINGERPRINT_THRESHOLD,
  hashValueAdaptiveWithDecision,
  selectAdaptiveFingerprintMode,
} from "../src/adaptive-fingerprint.js";
import { hashValueStreaming, hashValueStreamingWithMetrics } from "../src/streaming-fingerprint.js";
import { buildWorkspaceState } from "../src/realistic-workload.js";

const method = process.argv[2] || "adaptive";
const scenario = process.argv[3] || "workspace";
const measureMode = process.argv[4] || "memory";
const fileCount = Number(process.argv[5] || 2500);

if (!["monolithic", "streaming", "adaptive"].includes(method)) throw new Error("method must be monolithic, streaming, or adaptive");
if (!["workspace", "tiny"].includes(scenario)) throw new Error("scenario must be workspace or tiny");
if (!["memory", "timing"].includes(measureMode)) throw new Error("measureMode must be memory or timing");
if (!Number.isInteger(fileCount) || fileCount <= 0) throw new Error("fileCount must be a positive integer");
if (measureMode === "memory" && typeof global.gc !== "function") throw new Error("memory mode requires --expose-gc");

const value = scenario === "workspace"
  ? buildWorkspaceState({ fileCount })
  : { a: 1, b: "tiny", nested: [true, null, "x"], z: { q: 2 } };

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

function peakDelta(stages, field) {
  const baseline = stages[0].memory[field];
  return Math.max(0, ...stages.map((stage) => stage.memory[field] - baseline));
}

if (measureMode === "timing") {
  const started = performance.now();
  let hash;
  let routeMode = method;
  let estimate = null;
  if (method === "monolithic") {
    hash = hashValueMonolithic(value);
  } else if (method === "streaming") {
    hash = hashValueStreaming(value);
  } else {
    const adaptive = hashValueAdaptiveWithDecision(value);
    hash = adaptive.hash;
    routeMode = adaptive.mode;
    estimate = adaptive.estimate;
  }
  const wallMs = performance.now() - started;
  console.log(JSON.stringify({
    schema: "axm.ignition-adaptive-fingerprint-probe/v0.17",
    method,
    routeMode,
    scenario,
    measureMode,
    fileCount: scenario === "workspace" ? fileCount : null,
    thresholdCharacters: DEFAULT_ADAPTIVE_FINGERPRINT_THRESHOLD,
    hash,
    estimate,
    wallMs,
    timingBoundary: "Fresh Node process without forced-GC instrumentation. Value construction is excluded. Adaptive timing includes exactly one capped policy walk plus the selected fingerprint path.",
  }));
  process.exit(0);
}

const stages = [{ name: "baseline", memory: memorySnapshot() }];
let hash;
let routeMode = method;
let estimate = null;
let characterCount;
let chunkCount;
let maxChunkCharacters;

if (method === "monolithic") {
  let serialized = stableStringify(value);
  characterCount = serialized.length;
  chunkCount = 1;
  maxChunkCharacters = serialized.length;
  stages.push({ name: "serialization-live", memory: memorySnapshot() });
  hash = fnv1a32(serialized);
  stages.push({ name: "hash-complete-string-live", memory: memorySnapshot() });
  serialized = null;
  stages.push({ name: "serialization-dropped", memory: memorySnapshot() });
} else if (method === "streaming") {
  const streamed = hashValueStreamingWithMetrics(value);
  hash = streamed.hash;
  characterCount = streamed.metrics.characterCount;
  chunkCount = streamed.metrics.chunkCount;
  maxChunkCharacters = streamed.metrics.maxChunkCharacters;
  stages.push({ name: "streaming-hash-complete", memory: memorySnapshot() });
} else {
  const decision = selectAdaptiveFingerprintMode(value);
  routeMode = decision.mode;
  estimate = decision.estimate;
  stages.push({ name: "adaptive-decision-complete", memory: memorySnapshot() });
  if (routeMode === "monolithic") {
    let serialized = stableStringify(value);
    characterCount = serialized.length;
    chunkCount = 1;
    maxChunkCharacters = serialized.length;
    stages.push({ name: "adaptive-serialization-live", memory: memorySnapshot() });
    hash = fnv1a32(serialized);
    stages.push({ name: "adaptive-hash-complete-string-live", memory: memorySnapshot() });
    serialized = null;
    stages.push({ name: "adaptive-serialization-dropped", memory: memorySnapshot() });
  } else {
    const streamed = hashValueStreamingWithMetrics(value);
    hash = streamed.hash;
    characterCount = streamed.metrics.characterCount;
    chunkCount = streamed.metrics.chunkCount;
    maxChunkCharacters = streamed.metrics.maxChunkCharacters;
    stages.push({ name: "adaptive-streaming-hash-complete", memory: memorySnapshot() });
  }
}

const memoryFields = ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers", "v8MallocedMemory"];
console.log(JSON.stringify({
  schema: "axm.ignition-adaptive-fingerprint-probe/v0.17",
  method,
  routeMode,
  scenario,
  measureMode,
  fileCount: scenario === "workspace" ? fileCount : null,
  thresholdCharacters: DEFAULT_ADAPTIVE_FINGERPRINT_THRESHOLD,
  hash,
  estimate,
  characterCount,
  chunkCount,
  maxChunkCharacters,
  stages,
  peakDeltaFromBaseline: Object.fromEntries(memoryFields.map((field) => [field, peakDelta(stages, field)])),
  measurementBoundary: "Fresh --expose-gc Node process. Input value exists before baseline. Adaptive memory mode measures the capped decision first, then instruments the exact selected fixed path. Every recorded checkpoint forces GC. RSS/heap/external/ArrayBuffer remain overlapping envelopes.",
}));
