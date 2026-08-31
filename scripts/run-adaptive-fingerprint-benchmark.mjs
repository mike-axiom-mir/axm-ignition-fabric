import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_ADAPTIVE_FINGERPRINT_THRESHOLD } from "../src/adaptive-fingerprint.js";

const probe = fileURLToPath(new URL("./adaptive-fingerprint-probe.mjs", import.meta.url));
const samples = 5;
const workspaceSizes = [25, 100, 250, 500, 2500];

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function runProbe(method, scenario, measureMode, fileCount) {
  const args = measureMode === "memory"
    ? ["--expose-gc", probe, method, scenario, measureMode, String(fileCount)]
    : [probe, method, scenario, measureMode, String(fileCount)];
  const child = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (child.status !== 0) throw new Error(child.stderr || child.stdout || `probe failed: ${method}/${scenario}/${measureMode}/${fileCount}`);
  const lines = child.stdout.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines.at(-1));
}

function summarizeMemory(rows) {
  const fields = ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers", "v8MallocedMemory"];
  return {
    sampleCount: rows.length,
    hashes: [...new Set(rows.map((row) => row.hash))],
    routeModes: [...new Set(rows.map((row) => row.routeMode))],
    characterCount: median(rows.map((row) => row.characterCount)),
    chunkCount: median(rows.map((row) => row.chunkCount)),
    maxChunkCharacters: median(rows.map((row) => row.maxChunkCharacters)),
    estimate: rows[0].estimate ? {
      lowerBoundCharacters: median(rows.map((row) => row.estimate.lowerBoundCharacters)),
      nodesVisited: median(rows.map((row) => row.estimate.nodesVisited)),
      stringsVisited: median(rows.map((row) => row.estimate.stringsVisited)),
      complete: rows.every((row) => row.estimate.complete),
      exceedsThreshold: rows.every((row) => row.estimate.exceedsThreshold),
    } : null,
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
    routeModes: [...new Set(rows.map((row) => row.routeMode))],
    estimate: rows[0].estimate ? {
      lowerBoundCharacters: median(rows.map((row) => row.estimate.lowerBoundCharacters)),
      nodesVisited: median(rows.map((row) => row.estimate.nodesVisited)),
      complete: rows.every((row) => row.estimate.complete),
      exceedsThreshold: rows.every((row) => row.estimate.exceedsThreshold),
    } : null,
    wallMs: {
      median: median(rows.map((row) => row.wallMs)),
      min: Math.min(...rows.map((row) => row.wallMs)),
      max: Math.max(...rows.map((row) => row.wallMs)),
    },
  };
}

function measureScenario(scenario, fileCount) {
  const methods = {};
  for (const method of ["monolithic", "streaming", "adaptive"]) {
    const memoryRows = [];
    const timingRows = [];
    for (let i = 0; i < samples; i += 1) memoryRows.push(runProbe(method, scenario, "memory", fileCount));
    for (let i = 0; i < samples; i += 1) timingRows.push(runProbe(method, scenario, "timing", fileCount));
    methods[method] = {
      memory: summarizeMemory(memoryRows),
      timing: summarizeTiming(timingRows),
    };
  }

  const hashes = new Set();
  for (const method of Object.values(methods)) {
    method.memory.hashes.forEach((hash) => hashes.add(hash));
    method.timing.hashes.forEach((hash) => hashes.add(hash));
  }
  if (hashes.size !== 1) throw new Error(`${scenario}/${fileCount}: fingerprint mismatch across modes`);

  const characterCounts = new Set(Object.values(methods).map((method) => method.memory.characterCount));
  if (characterCounts.size !== 1) throw new Error(`${scenario}/${fileCount}: canonical character-count mismatch`);
  if (methods.adaptive.memory.routeModes.length !== 1 || methods.adaptive.timing.routeModes.length !== 1) {
    throw new Error(`${scenario}/${fileCount}: adaptive route was not deterministic`);
  }
  if (methods.adaptive.memory.routeModes[0] !== methods.adaptive.timing.routeModes[0]) {
    throw new Error(`${scenario}/${fileCount}: adaptive route differed between memory/timing probes`);
  }

  const route = methods.adaptive.memory.routeModes[0];
  const selected = methods[route];
  return {
    scenario,
    fileCount: scenario === "workspace" ? fileCount : null,
    hash: [...hashes][0],
    canonicalCharacters: [...characterCounts][0],
    adaptiveRoute: route,
    methods,
    observedDelta: {
      adaptiveVsMonolithicHeapUsedPeakSavedBytes:
        methods.monolithic.memory.peakDeltaFromBaseline.heapUsed.median - methods.adaptive.memory.peakDeltaFromBaseline.heapUsed.median,
      adaptiveVsMonolithicHeapTotalPeakSavedBytes:
        methods.monolithic.memory.peakDeltaFromBaseline.heapTotal.median - methods.adaptive.memory.peakDeltaFromBaseline.heapTotal.median,
      adaptiveVsMonolithicRssPeakSavedBytes:
        methods.monolithic.memory.peakDeltaFromBaseline.rss.median - methods.adaptive.memory.peakDeltaFromBaseline.rss.median,
      adaptiveMinusMonolithicTimingMs:
        methods.adaptive.timing.wallMs.median - methods.monolithic.timing.wallMs.median,
      adaptiveMinusSelectedFixedTimingMs:
        methods.adaptive.timing.wallMs.median - selected.timing.wallMs.median,
      adaptiveMinusSelectedFixedHeapUsedPeakBytes:
        methods.adaptive.memory.peakDeltaFromBaseline.heapUsed.median - selected.memory.peakDeltaFromBaseline.heapUsed.median,
    },
  };
}

const tiny = measureScenario("tiny", 1);
const workspace = workspaceSizes.map((fileCount) => measureScenario("workspace", fileCount));

if (tiny.adaptiveRoute !== "monolithic") throw new Error("tiny object must stay on monolithic path under default policy");
if (workspace.at(-1).adaptiveRoute !== "streaming") throw new Error("2,500-file workspace must choose streaming under default policy");

const firstStreaming = workspace.find((entry) => entry.adaptiveRoute === "streaming") ?? null;
const output = {
  schema: "axm.ignition-adaptive-fingerprint-comparison/v0.17",
  samples,
  thresholdCharacters: DEFAULT_ADAPTIVE_FINGERPRINT_THRESHOLD,
  workspaceSizes,
  tiny,
  workspace,
  observedPolicyBoundary: {
    firstStreamingFileCount: firstStreaming?.fileCount ?? null,
    firstStreamingCanonicalCharacters: firstStreaming?.canonicalCharacters ?? null,
    firstStreamingLowerBoundCharacters: firstStreaming?.methods.adaptive.memory.estimate?.lowerBoundCharacters ?? null,
    policyMeaning: "The default threshold is a deterministic memory high-water guard on a capped canonical lower bound, not a claim of universal CPU-optimal crossover.",
  },
  proofBoundary: {
    exactness: "Monolithic, streaming, and adaptive modes must produce one exact canonical hash and canonical character count for every scenario.",
    selection: "Adaptive selection uses a capped structural lower-bound walk and does not materialize stableStringify(value) merely to choose a route.",
    charging: "Adaptive timing includes one policy walk plus the selected hashing path. Memory probes include a post-decision checkpoint plus the selected path's live intermediates.",
    history: "The v0.16 fixed monolithic benchmark is pinned to hashValueMonolithic so core integration cannot silently relabel adaptive behavior as historical monolithic behavior.",
    counterexample: "Tiny inputs remain on the monolithic path because streaming adds overhead without solving a meaningful representation high-water problem.",
  },
};

console.log(JSON.stringify(output));
