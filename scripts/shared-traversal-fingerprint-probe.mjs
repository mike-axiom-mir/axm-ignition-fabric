import v8 from "node:v8";
import {
  fnv1a32,
  hashValueMonolithic,
  stableStringify,
} from "../src/ignition-core.js";
import {
  hashValueAdaptiveWithDecision,
  selectAdaptiveFingerprintMode,
} from "../src/adaptive-fingerprint.js";
import { hashValueStreamingWithMetrics } from "../src/streaming-fingerprint.js";
import {
  DEFAULT_SHARED_TRAVERSAL_THRESHOLD,
  hashValueSharedTraversalWithDecision,
} from "../src/shared-traversal-fingerprint.js";
import { buildWorkspaceState } from "../src/realistic-workload.js";

const method = process.argv[2] || "shared";
const scenario = process.argv[3] || "workspace";
const measureMode = process.argv[4] || "memory";
const fileCount = Number(process.argv[5] || 2500);

if (!["v017", "shared"].includes(method)) throw new Error("method must be v017 or shared");
if (!["workspace", "tiny", "giant-string"].includes(scenario)) throw new Error("scenario must be workspace, tiny, or giant-string");
if (!["memory", "timing"].includes(measureMode)) throw new Error("measureMode must be memory or timing");
if (!Number.isInteger(fileCount) || fileCount <= 0) throw new Error("fileCount must be a positive integer");
if (measureMode === "memory" && typeof global.gc !== "function") throw new Error("memory mode requires --expose-gc");

const value = scenario === "workspace"
  ? buildWorkspaceState({ fileCount })
  : scenario === "giant-string"
    ? "x".repeat(DEFAULT_SHARED_TRAVERSAL_THRESHOLD * 2)
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

function peakSites(stages, field) {
  const baseline = stages[0].memory[field];
  const peak = Math.max(0, ...stages.map((stage) => stage.memory[field] - baseline));
  return stages
    .filter((stage) => stage.memory[field] - baseline === peak)
    .map((stage) => stage.name);
}

if (measureMode === "timing") {
  const started = performance.now();
  const result = method === "v017"
    ? hashValueAdaptiveWithDecision(value)
    : hashValueSharedTraversalWithDecision(value);
  const wallMs = performance.now() - started;
  const expectedHash = hashValueMonolithic(value);
  if (result.hash !== expectedHash) throw new Error("fingerprint mismatch");

  console.log(JSON.stringify({
    schema: "axm.ignition-shared-traversal-fingerprint-probe/v0.18",
    method,
    scenario,
    measureMode,
    fileCount: scenario === "workspace" ? fileCount : null,
    thresholdCharacters: DEFAULT_SHARED_TRAVERSAL_THRESHOLD,
    hash: result.hash,
    routeMode: result.mode,
    estimate: method === "v017" ? result.estimate : null,
    metrics: method === "shared" ? result.metrics : null,
    wallMs,
    timingBoundary: "Fresh Node process without forced-GC instrumentation. Input construction and post-timing monolithic truth verification are excluded. v0.17 timing includes preflight plus selected hash path; shared timing includes one canonical traversal and in-flight route transition.",
  }));
  process.exit(0);
}

const stages = [{ name: "baseline", memory: memorySnapshot() }];
let hash;
let routeMode;
let estimate = null;
let metrics = null;
let selectedTraversalNodes = null;

if (method === "v017") {
  const decision = selectAdaptiveFingerprintMode(value);
  routeMode = decision.mode;
  estimate = decision.estimate;
  stages.push({ name: "v017-preflight-complete", memory: memorySnapshot() });

  if (routeMode === "monolithic") {
    let serialized = stableStringify(value);
    stages.push({ name: "v017-monolithic-string-live", memory: memorySnapshot() });
    hash = fnv1a32(serialized);
    stages.push({ name: "v017-monolithic-hash-complete-string-live", memory: memorySnapshot() });
    serialized = null;
    stages.push({ name: "v017-monolithic-string-dropped", memory: memorySnapshot() });
  } else {
    const streamed = hashValueStreamingWithMetrics(value);
    hash = streamed.hash;
    selectedTraversalNodes = streamed.metrics.nodesVisited;
    stages.push({ name: "v017-streaming-hash-complete", memory: memorySnapshot() });
  }
} else {
  const shared = hashValueSharedTraversalWithDecision(value, {
    phaseProbe: (details) => {
      stages.push({ name: `shared-${details.phase}`, details, memory: memorySnapshot() });
    },
  });
  hash = shared.hash;
  routeMode = shared.mode;
  metrics = shared.metrics;
}

const expectedHash = hashValueMonolithic(value);
if (hash !== expectedHash) throw new Error("fingerprint mismatch");
const canonicalCharacters = stableStringify(value).length;
const memoryFields = ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers", "v8MallocedMemory"];

console.log(JSON.stringify({
  schema: "axm.ignition-shared-traversal-fingerprint-probe/v0.18",
  method,
  scenario,
  measureMode,
  fileCount: scenario === "workspace" ? fileCount : null,
  thresholdCharacters: DEFAULT_SHARED_TRAVERSAL_THRESHOLD,
  hash,
  routeMode,
  canonicalCharacters,
  estimate,
  metrics,
  selectedTraversalNodes,
  stages,
  peakDeltaFromBaseline: Object.fromEntries(memoryFields.map((field) => [field, peakDelta(stages, field)])),
  peakSites: Object.fromEntries(memoryFields.map((field) => [field, peakSites(stages, field)])),
  measurementBoundary: "Fresh --expose-gc Node process. Input value exists before baseline. v0.17 measures preflight and then its selected historical path. Shared v0.18 uses phase checkpoints inside the single canonical traversal, including the threshold moment while the retained prefix is live. Truth verification and canonical length reconstruction happen only after all measured stages.",
}));
