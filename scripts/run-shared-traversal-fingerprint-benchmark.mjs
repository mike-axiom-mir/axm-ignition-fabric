import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const probe = fileURLToPath(new URL("./shared-traversal-fingerprint-probe.mjs", import.meta.url));
const samples = 5;
const workspaceSizes = [25, 100, 250, 500, 2500];
const methods = ["v017", "shared"];
const memoryFields = ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers", "v8MallocedMemory"];

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function runProbe(method, scenario, measureMode, fileCount = 2500) {
  const args = measureMode === "memory"
    ? ["--expose-gc", probe, method, scenario, measureMode, String(fileCount)]
    : [probe, method, scenario, measureMode, String(fileCount)];
  const child = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (child.status !== 0) throw new Error(child.stderr || child.stdout || `probe failed: ${method}/${scenario}/${measureMode}/${fileCount}`);
  const lines = child.stdout.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines.at(-1));
}

function summarizeMemory(rows) {
  const first = rows[0];
  const out = {
    sampleCount: rows.length,
    hashes: [...new Set(rows.map((row) => row.hash))],
    routeModes: [...new Set(rows.map((row) => row.routeMode))],
    canonicalCharacters: median(rows.map((row) => row.canonicalCharacters)),
    peakDeltaFromBaseline: Object.fromEntries(memoryFields.map((field) => [field, {
      median: median(rows.map((row) => row.peakDeltaFromBaseline[field])),
      min: Math.min(...rows.map((row) => row.peakDeltaFromBaseline[field])),
      max: Math.max(...rows.map((row) => row.peakDeltaFromBaseline[field])),
    }])),
  };

  if (first.estimate) {
    out.estimate = {
      lowerBoundCharacters: median(rows.map((row) => row.estimate.lowerBoundCharacters)),
      nodesVisited: median(rows.map((row) => row.estimate.nodesVisited)),
      stringsVisited: median(rows.map((row) => row.estimate.stringsVisited)),
      completeValues: [...new Set(rows.map((row) => row.estimate.complete))],
      exceedsThresholdValues: [...new Set(rows.map((row) => row.estimate.exceedsThreshold))],
    };
  } else {
    out.estimate = null;
  }

  if (first.metrics) {
    const metricFields = [
      "traversalPasses",
      "nodesVisited",
      "arraysVisited",
      "objectsVisited",
      "objectKeysVisited",
      "stringsVisited",
      "canonicalCharacterCount",
      "canonicalChunkCount",
      "maxCanonicalChunkCharacters",
      "switchAtCanonicalCharacter",
      "bufferedCharactersAtSwitch",
      "switchChunkCharacters",
      "finalBufferedCharacters",
      "maxRetainedCanonicalPrefixCharacters",
      "fnvFeedCharacterCount",
      "fnvFeedChunkCount",
      "fnvFeedMaxChunkCharacters",
      "objectTraversalRestarts",
    ];
    out.metrics = Object.fromEntries(metricFields.map((field) => {
      const values = rows.map((row) => row.metrics[field]).filter((value) => typeof value === "number");
      return [field, values.length ? median(values) : null];
    }));
  } else {
    out.metrics = null;
  }

  const selectedNodes = rows.map((row) => row.selectedTraversalNodes).filter((value) => typeof value === "number");
  out.selectedTraversalNodes = selectedNodes.length ? median(selectedNodes) : null;
  out.peakSites = Object.fromEntries(memoryFields.map((field) => {
    const counts = new Map();
    for (const row of rows) for (const site of row.peakSites[field]) counts.set(site, (counts.get(site) || 0) + 1);
    return [field, [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([site, count]) => ({ site, count }))];
  }));
  return out;
}

function summarizeTiming(rows) {
  const first = rows[0];
  const out = {
    sampleCount: rows.length,
    hashes: [...new Set(rows.map((row) => row.hash))],
    routeModes: [...new Set(rows.map((row) => row.routeMode))],
    wallMs: {
      median: median(rows.map((row) => row.wallMs)),
      min: Math.min(...rows.map((row) => row.wallMs)),
      max: Math.max(...rows.map((row) => row.wallMs)),
    },
  };
  if (first.estimate) {
    out.estimate = {
      lowerBoundCharacters: median(rows.map((row) => row.estimate.lowerBoundCharacters)),
      nodesVisited: median(rows.map((row) => row.estimate.nodesVisited)),
      completeValues: [...new Set(rows.map((row) => row.estimate.complete))],
    };
  } else if (first.metrics) {
    out.metrics = {
      nodesVisited: median(rows.map((row) => row.metrics.nodesVisited)),
      traversalPasses: median(rows.map((row) => row.metrics.traversalPasses)),
      objectTraversalRestarts: median(rows.map((row) => row.metrics.objectTraversalRestarts)),
    };
  }
  return out;
}

function runScenario(scenario, fileCount = 2500) {
  const summarized = {};
  for (const method of methods) {
    const memoryRows = [];
    const timingRows = [];
    for (let i = 0; i < samples; i += 1) memoryRows.push(runProbe(method, scenario, "memory", fileCount));
    for (let i = 0; i < samples; i += 1) timingRows.push(runProbe(method, scenario, "timing", fileCount));
    summarized[method] = {
      memory: summarizeMemory(memoryRows),
      timing: summarizeTiming(timingRows),
    };
  }

  const old = summarized.v017;
  const shared = summarized.shared;
  if (old.memory.hashes.length !== 1 || shared.memory.hashes.length !== 1 || old.memory.hashes[0] !== shared.memory.hashes[0]) {
    throw new Error(`${scenario}/${fileCount}: memory fingerprint mismatch`);
  }
  if (old.timing.hashes.length !== 1 || shared.timing.hashes.length !== 1 || old.timing.hashes[0] !== shared.timing.hashes[0]) {
    throw new Error(`${scenario}/${fileCount}: timing fingerprint mismatch`);
  }
  if (old.memory.routeModes.length !== 1 || shared.memory.routeModes.length !== 1 || old.memory.routeModes[0] !== shared.memory.routeModes[0]) {
    throw new Error(`${scenario}/${fileCount}: route mismatch`);
  }
  if (old.memory.canonicalCharacters !== shared.memory.canonicalCharacters) throw new Error(`${scenario}/${fileCount}: canonical character mismatch`);
  if (shared.memory.metrics.traversalPasses !== 1 || shared.memory.metrics.objectTraversalRestarts !== 0) throw new Error(`${scenario}/${fileCount}: shared traversal restarted`);
  if (shared.memory.metrics.fnvFeedCharacterCount !== shared.memory.canonicalCharacters) throw new Error(`${scenario}/${fileCount}: shared FNV character mismatch`);
  if (old.memory.selectedTraversalNodes !== null && old.memory.selectedTraversalNodes !== shared.memory.metrics.nodesVisited) {
    throw new Error(`${scenario}/${fileCount}: selected traversal node mismatch`);
  }

  const preflightNodes = old.memory.estimate?.nodesVisited ?? 0;
  const sharedNodes = shared.memory.metrics.nodesVisited;
  return {
    scenario,
    fileCount: scenario === "workspace" ? fileCount : null,
    hash: old.memory.hashes[0],
    canonicalCharacters: old.memory.canonicalCharacters,
    routeMode: old.memory.routeModes[0],
    methods: summarized,
    observedDelta: {
      timingV017MinusSharedMs: old.timing.wallMs.median - shared.timing.wallMs.median,
      heapUsedPeakV017MinusSharedBytes: old.memory.peakDeltaFromBaseline.heapUsed.median - shared.memory.peakDeltaFromBaseline.heapUsed.median,
      heapTotalPeakV017MinusSharedBytes: old.memory.peakDeltaFromBaseline.heapTotal.median - shared.memory.peakDeltaFromBaseline.heapTotal.median,
      rssPeakV017MinusSharedBytes: old.memory.peakDeltaFromBaseline.rss.median - shared.memory.peakDeltaFromBaseline.rss.median,
      v017PreflightNodes: preflightNodes,
      sharedCanonicalTraversalNodes: sharedNodes,
      structuralNodeVisitsAvoided: preflightNodes,
      conceptualV017NodeVisits: preflightNodes + sharedNodes,
      sharedObjectTraversalRestarts: shared.memory.metrics.objectTraversalRestarts,
      sharedMaxRetainedCanonicalPrefixCharacters: shared.memory.metrics.maxRetainedCanonicalPrefixCharacters,
    },
  };
}

const tiny = runScenario("tiny");
const giantString = runScenario("giant-string");
const workspace = workspaceSizes.map((fileCount) => runScenario("workspace", fileCount));

const output = {
  schema: "axm.ignition-shared-traversal-fingerprint-comparison/v0.18",
  samples,
  thresholdCharacters: 65536,
  workspaceSizes,
  tiny,
  giantString,
  workspace,
  strongestDirectComparison: workspace.find((row) => row.fileCount === 2500),
  proofBoundary: {
    exactness: "v0.17 adaptive and v0.18 shared-traversal paths must produce one exact canonical hash, canonical character count, and route on every measured input.",
    singleTraversal: "v0.18 canonical serialization emits each graph node through one instrumented traversal pass and reports objectTraversalRestarts=0. The avoided structural-node count is the v0.17 preflight node count that previously occurred before the selected full hash traversal.",
    memory: "Fresh --expose-gc processes measure v0.17 preflight + selected historical path versus v0.18 in-flight threshold/prefix lifetime checkpoints. RSS, heap, external, and ArrayBuffer are separate overlapping envelopes.",
    timing: "Five separate fresh timing processes per method/input. v0.17 includes preflight + selected hash; v0.18 includes prefix buffering + in-flight switch + remaining hash. Hosted medians are observations, not production distributions.",
    smallCounterexample: "Small inputs may remain slower or use more heap under shared traversal because constructing canonical chunks solely to preserve an in-flight route choice can cost more than v0.17's cheap preflight plus optimized monolithic serializer.",
    giantStringCounterexample: "A giant primitive string already has an O(1)-node v0.17 preflight and is emitted by the current canonical streamer as one large JSON string chunk, so shared traversal is not expected to create the same benefit as a large composite graph.",
  },
};

console.log(JSON.stringify(output));
