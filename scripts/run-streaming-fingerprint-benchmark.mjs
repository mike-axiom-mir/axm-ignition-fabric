import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const probe = fileURLToPath(new URL("./fingerprint-streaming-probe.mjs", import.meta.url));
const samples = 5;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function runProbe(method, scenario, measureMode) {
  const args = measureMode === "memory"
    ? ["--expose-gc", probe, method, scenario, measureMode, "2500"]
    : [probe, method, scenario, measureMode, "2500"];
  const child = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (child.status !== 0) throw new Error(child.stderr || child.stdout || `probe failed: ${method}/${scenario}/${measureMode}`);
  const lines = child.stdout.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines.at(-1));
}

function summarizeMemory(rows) {
  const fields = ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers", "v8MallocedMemory"];
  return {
    sampleCount: rows.length,
    hashes: [...new Set(rows.map((row) => row.hash))],
    characterCount: median(rows.map((row) => row.characterCount)),
    chunkCount: median(rows.map((row) => row.chunkCount)),
    maxChunkCharacters: median(rows.map((row) => row.maxChunkCharacters)),
    peakDeltaFromBaseline: Object.fromEntries(fields.map((field) => [field, {
      median: median(rows.map((row) => row.peakDeltaFromBaseline[field])),
      min: Math.min(...rows.map((row) => row.peakDeltaFromBaseline[field])),
      max: Math.max(...rows.map((row) => row.peakDeltaFromBaseline[field])),
    }])),
  };
}

function summarizeTiming(rows) {
  return {
    sampleCount: rows.length,
    hashes: [...new Set(rows.map((row) => row.hash))],
    wallMs: {
      median: median(rows.map((row) => row.wallMs)),
      min: Math.min(...rows.map((row) => row.wallMs)),
      max: Math.max(...rows.map((row) => row.wallMs)),
    },
  };
}

const results = {};
for (const scenario of ["workspace", "tiny"]) {
  results[scenario] = {};
  for (const method of ["monolithic", "streaming"]) {
    const memoryRows = [];
    const timingRows = [];
    for (let i = 0; i < samples; i += 1) memoryRows.push(runProbe(method, scenario, "memory"));
    for (let i = 0; i < samples; i += 1) timingRows.push(runProbe(method, scenario, "timing"));
    results[scenario][method] = {
      memory: summarizeMemory(memoryRows),
      timing: summarizeTiming(timingRows),
    };
  }

  const left = results[scenario].monolithic;
  const right = results[scenario].streaming;
  if (left.memory.hashes.length !== 1 || right.memory.hashes.length !== 1 || left.memory.hashes[0] !== right.memory.hashes[0]) {
    throw new Error(`${scenario}: memory fingerprint mismatch`);
  }
  if (left.timing.hashes.length !== 1 || right.timing.hashes.length !== 1 || left.timing.hashes[0] !== right.timing.hashes[0]) {
    throw new Error(`${scenario}: timing fingerprint mismatch`);
  }
  if (left.memory.characterCount !== right.memory.characterCount) throw new Error(`${scenario}: serialized character count mismatch`);
  if (right.memory.maxChunkCharacters > left.memory.maxChunkCharacters) throw new Error(`${scenario}: streaming chunk exceeded monolithic serialization`);
}

const workspace = results.workspace;
const tiny = results.tiny;
const output = {
  schema: "axm.ignition-streaming-fingerprint-comparison/v0.16",
  samples,
  fileCount: 2500,
  results,
  observedWorkspaceDelta: {
    fullSerializationCharacters: workspace.monolithic.memory.characterCount,
    streamingMaxChunkCharacters: workspace.streaming.memory.maxChunkCharacters,
    heapUsedPeakSavedBytes: workspace.monolithic.memory.peakDeltaFromBaseline.heapUsed.median - workspace.streaming.memory.peakDeltaFromBaseline.heapUsed.median,
    heapTotalPeakSavedBytes: workspace.monolithic.memory.peakDeltaFromBaseline.heapTotal.median - workspace.streaming.memory.peakDeltaFromBaseline.heapTotal.median,
    rssPeakSavedBytes: workspace.monolithic.memory.peakDeltaFromBaseline.rss.median - workspace.streaming.memory.peakDeltaFromBaseline.rss.median,
    timingMonolithicMinusStreamingMs: workspace.monolithic.timing.wallMs.median - workspace.streaming.timing.wallMs.median,
  },
  tinyCounterexample: {
    serializationCharacters: tiny.monolithic.memory.characterCount,
    streamingMaxChunkCharacters: tiny.streaming.memory.maxChunkCharacters,
    heapUsedPeakSavedBytes: tiny.monolithic.memory.peakDeltaFromBaseline.heapUsed.median - tiny.streaming.memory.peakDeltaFromBaseline.heapUsed.median,
    rssPeakSavedBytes: tiny.monolithic.memory.peakDeltaFromBaseline.rss.median - tiny.streaming.memory.peakDeltaFromBaseline.rss.median,
    timingMonolithicMinusStreamingMs: tiny.monolithic.timing.wallMs.median - tiny.streaming.timing.wallMs.median,
  },
  proofBoundary: {
    exactness: "Both methods must produce the exact same canonical FNV-1a hash and serialized UTF-16 character count for each scenario.",
    monolithicMemory: "Memory mode deliberately checkpoints while the complete stableStringify result is live, matching the intermediate value required by the current hashValue(value)=fnv1a32(stableStringify(value)) path.",
    streamingMemory: "Streaming mode emits bounded canonical chunks directly into incremental FNV and never constructs the complete serialization string.",
    timing: "Timing runs are separate fresh processes without forced-GC checkpoints. Five hosted samples are observations, not a broad statistical distribution.",
    counterexample: "The tiny-object case is retained even if streaming is slower or yields no meaningful process high-water reduction.",
  },
};

console.log(JSON.stringify(output));
