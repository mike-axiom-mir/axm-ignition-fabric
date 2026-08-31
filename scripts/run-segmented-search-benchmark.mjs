import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, "segmented-search-probe.mjs");
const segmentBitsValues = [0, 2, 4, 6];
const samples = 5;
const fileCount = 2500;

function runProbe(mode, segmentBits) {
  return new Promise((resolve, reject) => {
    const args = mode === "memory"
      ? ["--expose-gc", probe, mode, String(segmentBits), String(fileCount)]
      : [probe, mode, String(segmentBits), String(fileCount)];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`segmented search probe failed: ${mode}/bits${segmentBits} exit ${code}`));
      try {
        resolve(JSON.parse(stdout.trim().split("\n").at(-1)));
      } catch (error) {
        reject(new Error(`invalid segmented search probe output: ${mode}/bits${segmentBits}: ${error.message}`));
      }
    });
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function stats(rows, key) {
  const values = rows.map((row) => row[key]);
  return { median: median(values), min: Math.min(...values), max: Math.max(...values) };
}

function peakSites(rows, metric = "arrayBuffers") {
  const counts = new Map();
  for (const row of rows) {
    const peak = row.peakObservations?.[metric];
    const key = `${peak?.phase || "unknown"}|${peak?.capabilityId || "none"}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [phase, capabilityId] = key.split("|");
      return { phase, capabilityId: capabilityId === "none" ? null : capabilityId, count };
    })
    .sort((a, b) => b.count - a.count || a.phase.localeCompare(b.phase) || String(a.capabilityId).localeCompare(String(b.capabilityId)));
}

const results = {};
const allHashes = new Set();
for (const segmentBits of segmentBitsValues) {
  const memoryRows = [];
  const timingRows = [];
  for (let sample = 0; sample < samples; sample += 1) memoryRows.push(await runProbe("memory", segmentBits));
  for (let sample = 0; sample < samples; sample += 1) timingRows.push(await runProbe("timing", segmentBits));
  for (const row of [...memoryRows, ...timingRows]) allHashes.add(row.resultHash);

  const declaredPeak = stats(memoryRows, "declaredPeakLiveBodyBytes");
  const arrayBufferPeak = stats(memoryRows, "measuredPeakArrayBufferDeltaBytes");
  results[String(segmentBits)] = {
    segmentBits,
    segmentCount: 2 ** segmentBits,
    sampleCount: samples,
    resultHashes: [...new Set([...memoryRows, ...timingRows].map((row) => row.resultHash))],
    totalMaterializedBytes: stats(memoryRows, "totalMaterializedBytes"),
    searchMaterializedBytes: stats(memoryRows, "searchMaterializedBytes"),
    declaredPeakLiveBodyBytes: declaredPeak,
    measuredPeakArrayBufferDeltaBytes: arrayBufferPeak,
    measuredPeakExternalDeltaBytes: stats(memoryRows, "measuredPeakExternalDeltaBytes"),
    measuredPeakRssDeltaBytes: stats(memoryRows, "measuredPeakRssDeltaBytes"),
    measuredPeakHeapUsedDeltaBytes: stats(memoryRows, "measuredPeakHeapUsedDeltaBytes"),
    declaredVsArrayBufferPeakGapBytes: arrayBufferPeak.median - declaredPeak.median,
    arrayBufferPeakSites: peakSites(memoryRows, "arrayBuffers"),
    wallMs: stats(timingRows, "wallMs"),
  };
}

if (allHashes.size !== 1) throw new Error(`segmentation changed deterministic report output: ${[...allHashes].join(",")}`);
const baseline = results["0"];
const candidates = segmentBitsValues.slice(1).map((bits) => results[String(bits)]);
const lowestPeak = [...candidates].sort((a, b) =>
  a.measuredPeakArrayBufferDeltaBytes.median - b.measuredPeakArrayBufferDeltaBytes.median || a.segmentBits - b.segmentBits
)[0];
const fastest = [baseline, ...candidates].sort((a, b) => a.wallMs.median - b.wallMs.median || a.segmentBits - b.segmentBits)[0];

if (baseline.measuredPeakArrayBufferDeltaBytes.median !== baseline.declaredPeakLiveBodyBytes.median) {
  throw new Error("segmentBits=0 ArrayBuffer peak does not reproduce declared atomic-body baseline");
}
if (lowestPeak.measuredPeakArrayBufferDeltaBytes.median >= baseline.measuredPeakArrayBufferDeltaBytes.median) {
  throw new Error("no segmented configuration reduced measured ArrayBuffer peak");
}

console.log(JSON.stringify({
  schema: "axm.ignition-segmented-search-comparison/v0.13",
  fileCount,
  samples,
  segmentBitsValues,
  resultHash: [...allHashes][0],
  results,
  observedBestPeak: {
    segmentBits: lowestPeak.segmentBits,
    segmentCount: lowestPeak.segmentCount,
    baselineArrayBufferPeakBytes: baseline.measuredPeakArrayBufferDeltaBytes.median,
    segmentedArrayBufferPeakBytes: lowestPeak.measuredPeakArrayBufferDeltaBytes.median,
    savedArrayBufferPeakBytes: baseline.measuredPeakArrayBufferDeltaBytes.median - lowestPeak.measuredPeakArrayBufferDeltaBytes.median,
    baselineDeclaredPeakBytes: baseline.declaredPeakLiveBodyBytes.median,
    segmentedDeclaredPeakBytes: lowestPeak.declaredPeakLiveBodyBytes.median,
    baselineSearchBodyBytes: baseline.searchMaterializedBytes.median,
    segmentedSearchBodyBytes: lowestPeak.searchMaterializedBytes.median,
    savedSearchBodyBytes: baseline.searchMaterializedBytes.median - lowestPeak.searchMaterializedBytes.median,
    baselineTotalMaterializedBytes: baseline.totalMaterializedBytes.median,
    segmentedTotalMaterializedBytes: lowestPeak.totalMaterializedBytes.median,
    segmentedPhysicalGapBytes: lowestPeak.declaredVsArrayBufferPeakGapBytes,
    segmentedArrayBufferPeakSites: lowestPeak.arrayBufferPeakSites,
  },
  observedFastestTiming: {
    segmentBits: fastest.segmentBits,
    segmentCount: fastest.segmentCount,
    wallMsMedian: fastest.wallMs.median,
    baselineWallMsMedian: baseline.wallMs.median,
  },
  proofBoundary: {
    exactOutput: "All segmentation levels must produce one identical deterministic seven-body report hash.",
    baseline: "segmentBits=0 is the same request-scoped search implementation with one partition and must reproduce the atomic search-body peak.",
    memory: "Declared reachable runtime-body bytes and measured ArrayBuffer peak are separate. Peak lifecycle attribution is retained when they diverge; external, heap and RSS are secondary and may disagree.",
    cache: "v0.13 segmented search is benchmarked with zero retention because request-bound segment cache identity is not yet implemented.",
    counterexample: "A concentrated-token unit test proves segmentation cannot shrink a body when all relevant tokens occupy one partition."
  }
}));
