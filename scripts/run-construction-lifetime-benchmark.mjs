import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, "construction-lifetime-probe.mjs");
const samples = 5;
const fileCount = 2500;
const modes = ["encoder", "scalar"];
const targets = ["metadata", "report"];

function runProbe(metadataMode, target, measureMode) {
  return new Promise((resolve, reject) => {
    const args = measureMode === "memory"
      ? ["--expose-gc", probe, metadataMode, target, measureMode, String(fileCount)]
      : [probe, metadataMode, target, measureMode, String(fileCount)];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`construction probe failed: ${metadataMode}/${target}/${measureMode} exit ${code}`));
      try {
        resolve(JSON.parse(stdout.trim().split("\n").at(-1)));
      } catch (error) {
        reject(new Error(`invalid construction probe output: ${metadataMode}/${target}/${measureMode}: ${error.message}`));
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

function summarize(memoryRows, timingRows) {
  return {
    sampleCount: samples,
    resultHashes: [...new Set([...memoryRows, ...timingRows].map((row) => row.resultHash))],
    metadataBodyBytes: stats(memoryRows, "metadataBodyBytes"),
    totalMaterializedBytes: stats(memoryRows, "totalMaterializedBytes"),
    declaredPeakLiveBodyBytes: stats(memoryRows, "declaredPeakLiveBodyBytes"),
    measuredPeakArrayBufferDeltaBytes: stats(memoryRows, "measuredPeakArrayBufferDeltaBytes"),
    measuredPeakExternalDeltaBytes: stats(memoryRows, "measuredPeakExternalDeltaBytes"),
    measuredPeakRssDeltaBytes: stats(memoryRows, "measuredPeakRssDeltaBytes"),
    measuredPeakHeapUsedDeltaBytes: stats(memoryRows, "measuredPeakHeapUsedDeltaBytes"),
    arrayBufferPeakSites: [...new Set(memoryRows.flatMap((row) => row.arrayBufferPeakSites.map((site) => `${site.phase}:${site.capabilityId}`)))].sort(),
    wallMs: stats(timingRows, "wallMs"),
  };
}

const results = {};
for (const target of targets) {
  results[target] = {};
  for (const metadataMode of modes) {
    const memoryRows = [];
    const timingRows = [];
    for (let i = 0; i < samples; i += 1) memoryRows.push(await runProbe(metadataMode, target, "memory"));
    for (let i = 0; i < samples; i += 1) timingRows.push(await runProbe(metadataMode, target, "timing"));
    results[target][metadataMode] = summarize(memoryRows, timingRows);
  }
}

for (const target of targets) {
  const encoder = results[target].encoder;
  const scalar = results[target].scalar;
  if (encoder.resultHashes.length !== 1 || scalar.resultHashes.length !== 1 || encoder.resultHashes[0] !== scalar.resultHashes[0]) {
    throw new Error(`${target} result changed between encoder and scalar metadata construction`);
  }
  if (encoder.metadataBodyBytes.median !== scalar.metadataBodyBytes.median) {
    throw new Error(`${target} persistent metadata body size changed between construction methods`);
  }
}

const metadataEncoderPeak = results.metadata.encoder.measuredPeakArrayBufferDeltaBytes.median;
const metadataScalarPeak = results.metadata.scalar.measuredPeakArrayBufferDeltaBytes.median;
const reportEncoderPeak = results.report.encoder.measuredPeakArrayBufferDeltaBytes.median;
const reportScalarPeak = results.report.scalar.measuredPeakArrayBufferDeltaBytes.median;

if (metadataScalarPeak >= metadataEncoderPeak) throw new Error("scalar metadata construction did not reduce metadata-only ArrayBuffer peak");
if (reportScalarPeak >= reportEncoderPeak) throw new Error("scalar metadata construction did not reduce 64-segment report ArrayBuffer peak");

console.log(JSON.stringify({
  schema: "axm.ignition-construction-lifetime-comparison/v0.14",
  fileCount,
  samples,
  segmentBits: 6,
  results,
  observedDelta: {
    metadataArrayBufferPeakSavedBytes: metadataEncoderPeak - metadataScalarPeak,
    reportArrayBufferPeakSavedBytes: reportEncoderPeak - reportScalarPeak,
    reportDeclaredPeakBytes: results.report.scalar.declaredPeakLiveBodyBytes.median,
    reportScalarMeasuredPeakBytes: reportScalarPeak,
    reportPhysicalGapBytes: reportScalarPeak - results.report.scalar.declaredPeakLiveBodyBytes.median,
    encoderMetadataPeakSites: results.metadata.encoder.arrayBufferPeakSites,
    scalarMetadataPeakSites: results.metadata.scalar.arrayBufferPeakSites,
    encoderReportPeakSites: results.report.encoder.arrayBufferPeakSites,
    scalarReportPeakSites: results.report.scalar.arrayBufferPeakSites,
  },
  proofBoundary: {
    causeIsolation: "The only intentional difference is metadata byte-length construction: TextEncoder.encode(text).byteLength versus a scalar UTF-8 counter. Persistent metadata arrays and report outputs must remain identical.",
    memory: "Primary claim is fresh-process forced-GC ArrayBuffer peak. RSS/external/heap are secondary observations and may disagree.",
    timing: "Timing uses separate fresh processes without forced-GC instrumentation and is workload-specific.",
    scope: "This isolates one construction-time typed-array source in this fixture; it does not prove every temporary allocation is removed."
  }
}));
