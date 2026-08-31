import v8 from "node:v8";
import { fnv1a32, hashValue, stableStringify } from "../src/ignition-core.js";
import { hashValueStreaming, hashValueStreamingWithMetrics } from "../src/streaming-fingerprint.js";
import { buildWorkspaceState } from "../src/realistic-workload.js";

const method = process.argv[2] || "monolithic";
const scenario = process.argv[3] || "workspace";
const measureMode = process.argv[4] || "memory";
const fileCount = Number(process.argv[5] || 2500);

if (!["monolithic", "streaming"].includes(method)) throw new Error("method must be monolithic or streaming");
if (!["workspace", "tiny"].includes(scenario)) throw new Error("scenario must be workspace or tiny");
if (!["memory", "timing"].includes(measureMode)) throw new Error("measureMode must be memory or timing");
if (!Number.isInteger(fileCount) || fileCount <= 0) throw new Error("fileCount must be a positive integer");
if (measureMode === "memory" && typeof global.gc !== "function") throw new Error("memory mode requires --expose-gc");

const value = scenario === "workspace"
  ? buildWorkspaceState({ fileCount })
  : { a: 1, b: "tiny", nested: [true, null, "x"], z: { q: 2 } };

const expectedHash = hashValue(value);

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
  const hash = method === "monolithic" ? hashValue(value) : hashValueStreaming(value);
  const wallMs = performance.now() - started;
  if (hash !== expectedHash) throw new Error("fingerprint mismatch");
  console.log(JSON.stringify({
    schema: "axm.ignition-streaming-fingerprint-probe/v0.16",
    method,
    scenario,
    measureMode,
    fileCount: scenario === "workspace" ? fileCount : null,
    hash,
    wallMs,
    timingBoundary: "Fresh Node process. Value construction and reference-hash verification are excluded from the measured fingerprint call.",
  }));
  process.exit(0);
}

const stages = [{ name: "baseline", memory: memorySnapshot() }];
let hash;
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
} else {
  const streamed = hashValueStreamingWithMetrics(value);
  hash = streamed.hash;
  characterCount = streamed.metrics.characterCount;
  chunkCount = streamed.metrics.chunkCount;
  maxChunkCharacters = streamed.metrics.maxChunkCharacters;
  stages.push({ name: "streaming-hash-complete", memory: memorySnapshot() });
}

if (hash !== expectedHash) throw new Error("fingerprint mismatch");

const memoryFields = ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers", "v8MallocedMemory"];
console.log(JSON.stringify({
  schema: "axm.ignition-streaming-fingerprint-probe/v0.16",
  method,
  scenario,
  measureMode,
  fileCount: scenario === "workspace" ? fileCount : null,
  hash,
  characterCount,
  chunkCount,
  maxChunkCharacters,
  stages,
  peakDeltaFromBaseline: Object.fromEntries(memoryFields.map((field) => [field, peakDelta(stages, field)])),
  measurementBoundary: "Fresh --expose-gc Node process. The input value is constructed before the baseline. Monolithic mode deliberately checkpoints while the complete stableStringify result is live, then after FNV and after dropping that string. Streaming mode never constructs the complete canonical string and checkpoints after the incremental hash. Every recorded checkpoint forces GC.",
}));
