import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, "canonical-size-hint-probe.mjs");
const methods = ["v017", "hinted"];
const scenarios = ["path", "same-width", "threshold"];
const samples = 5;

function runProbe(method, scenario, measureMode) {
  return new Promise((resolve, reject) => {
    const args = measureMode === "memory"
      ? ["--expose-gc", probe, method, scenario, measureMode]
      : [probe, method, scenario, measureMode];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`canonical size hint probe failed: ${method}/${scenario}/${measureMode} exit ${code}`));
      try {
        resolve(JSON.parse(stdout.trim().split("\n").at(-1)));
      } catch (error) {
        reject(new Error(`invalid canonical size hint probe output: ${method}/${scenario}/${measureMode}: ${error.message}`));
      }
    });
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function stats(rows, selector) {
  const values = rows.map(selector);
  return { median: median(values), min: Math.min(...values), max: Math.max(...values) };
}

const results = {};
for (const scenario of scenarios) {
  results[scenario] = {};
  for (const method of methods) {
    const timingRows = [];
    const memoryRows = [];
    for (let i = 0; i < samples; i += 1) timingRows.push(await runProbe(method, scenario, "timing"));
    for (let i = 0; i < samples; i += 1) memoryRows.push(await runProbe(method, scenario, "memory"));

    const hashes = [...new Set([...timingRows, ...memoryRows].map((row) => row.finalHash))];
    const chars = [...new Set([...timingRows, ...memoryRows].map((row) => row.finalCanonicalCharacters))];
    if (hashes.length !== 1) throw new Error(`${scenario}/${method} produced unstable hashes`);
    if (chars.length !== 1) throw new Error(`${scenario}/${method} produced unstable canonical character counts`);
    if (method === "hinted" && [...timingRows, ...memoryRows].some((row) => row.maintainedCanonicalCharacters !== row.finalCanonicalCharacters)) {
      throw new Error(`${scenario} hinted canonical size drifted from exact reference`);
    }

    results[scenario][method] = {
      hash: hashes[0],
      canonicalCharacters: chars[0],
      routes: [...new Set(timingRows.flatMap((row) => row.routes || [row.route]))],
      iterations: timingRows[0].iterations,
      timingWallMs: stats(timingRows, (row) => row.wallMs),
      totalPreflightNodes: stats(timingRows, (row) => row.totalPreflightNodes),
      totalSizeHintFileInspections: stats(timingRows, (row) => row.totalSizeHintFileInspections),
      memoryPeak: {
        rss: stats(memoryRows, (row) => row.peakDeltaFromBaseline.rss),
        heapTotal: stats(memoryRows, (row) => row.peakDeltaFromBaseline.heapTotal),
        heapUsed: stats(memoryRows, (row) => row.peakDeltaFromBaseline.heapUsed),
        external: stats(memoryRows, (row) => row.peakDeltaFromBaseline.external),
        arrayBuffers: stats(memoryRows, (row) => row.peakDeltaFromBaseline.arrayBuffers),
        v8MallocedMemory: stats(memoryRows, (row) => row.peakDeltaFromBaseline.v8MallocedMemory),
      },
      memoryPreflightNodes: stats(memoryRows, (row) => row.preflightNodes),
    };
  }

  const baseline = results[scenario].v017;
  const hinted = results[scenario].hinted;
  if (baseline.hash !== hinted.hash) throw new Error(`${scenario} hinted route changed fingerprint truth`);
  if (baseline.canonicalCharacters !== hinted.canonicalCharacters) throw new Error(`${scenario} hinted route changed canonical character count`);
  if (JSON.stringify(baseline.routes) !== JSON.stringify(hinted.routes)) throw new Error(`${scenario} hinted route changed measured route decision`);
  if (baseline.totalPreflightNodes.median <= 0) throw new Error(`${scenario} v0.17 baseline did not record adaptive preflight nodes`);
  if (hinted.totalPreflightNodes.median !== 0) throw new Error(`${scenario} hinted route unexpectedly performed adaptive preflight`);
  if (hinted.totalSizeHintFileInspections.median !== hinted.iterations) throw new Error(`${scenario} hinted route did not maintain size from exactly one file per point mutation`);
}

const observedDelta = Object.fromEntries(scenarios.map((scenario) => {
  const baseline = results[scenario].v017;
  const hinted = results[scenario].hinted;
  return [scenario, {
    timingV017MinusHintedMs: baseline.timingWallMs.median - hinted.timingWallMs.median,
    preflightNodesAvoided: baseline.totalPreflightNodes.median,
    sizeHintFileInspections: hinted.totalSizeHintFileInspections.median,
    heapUsedPeakV017MinusHintedBytes: baseline.memoryPeak.heapUsed.median - hinted.memoryPeak.heapUsed.median,
    heapTotalPeakV017MinusHintedBytes: baseline.memoryPeak.heapTotal.median - hinted.memoryPeak.heapTotal.median,
    rssPeakV017MinusHintedBytes: baseline.memoryPeak.rss.median - hinted.memoryPeak.rss.median,
  }];
}));

console.log(JSON.stringify({
  schema: "axm.ignition-canonical-size-hint-comparison/v0.19",
  samples,
  thresholdCharacters: 65536,
  results,
  observedDelta,
  proofBoundary: {
    exactness: "Both methods must produce the same final canonical hash, exact canonical character count, and route for every scenario.",
    maintainedTruth: "The hinted path must equal an independently recomputed canonical character count after every measured final state; tests verify every intermediate transition as well.",
    mutationScope: "The v0.19 tracked path changes exactly one file per supported transition and derives the next canonical size from only that old/new file pair.",
    routeCost: "v0.17 reports structural preflight nodes. The hinted fingerprint route reports zero preflight nodes and one size-hint file inspection per point mutation.",
    timing: "Initial state construction/bootstrap is excluded for both paths. Five fresh hosted processes per method/scenario are observational rather than a production distribution.",
    memory: "Fresh --expose-gc memory probes record overlapping RSS/heap/external/ArrayBuffer envelopes. Physical memory is observational, not a hard equality oracle.",
    fallback: "Ordinary untracked hashValue(value) remains the sealed v0.17 adaptive policy. v0.19 does not silently trust caller-supplied size metadata for arbitrary values."
  }
}));
