import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, "streamed-peak-probe.mjs");
const fileCount = 2500;
const samples = 5;
const scenarios = ["report", "single"];
const modes = ["whole-memory", "streamed-memory", "whole-timing", "streamed-timing"];

function runProbe(mode, scenario) {
  return new Promise((resolve, reject) => {
    const args = mode.endsWith("memory")
      ? ["--expose-gc", probe, mode, scenario, String(fileCount)]
      : [probe, mode, scenario, String(fileCount)];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`streamed peak probe failed: ${mode}/${scenario} exit ${code}`));
      try {
        resolve(JSON.parse(stdout.trim().split("\n").at(-1)));
      } catch (error) {
        reject(new Error(`invalid streamed peak probe output for ${mode}/${scenario}: ${error.message}`));
      }
    });
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function stats(values) {
  return { median: median(values), min: Math.min(...values), max: Math.max(...values) };
}

function summarize(rows) {
  const summary = {
    samples: rows.length,
    resultHashes: [...new Set(rows.map((row) => row.resultHash))],
    totalMaterializedBytes: stats(rows.map((row) => row.totalMaterializedBytes)),
    declaredPeakLiveBodyBytes: stats(rows.map((row) => row.declaredPeakLiveBodyBytes)),
  };
  if (rows[0].wallMs !== undefined) summary.wallMs = stats(rows.map((row) => row.wallMs));
  if (rows[0].measuredPeakArrayBufferDeltaBytes !== undefined) {
    summary.measuredPeakArrayBufferDeltaBytes = stats(rows.map((row) => row.measuredPeakArrayBufferDeltaBytes));
    summary.measuredPeakExternalDeltaBytes = stats(rows.map((row) => row.measuredPeakExternalDeltaBytes));
    summary.measuredPeakRssDeltaBytes = stats(rows.map((row) => row.measuredPeakRssDeltaBytes));
  }
  return summary;
}

for (const scenario of scenarios) {
  const rowsByMode = Object.fromEntries(modes.map((mode) => [mode, []]));
  for (const mode of modes) {
    for (let sample = 0; sample < samples; sample += 1) {
      rowsByMode[mode].push(await runProbe(mode, scenario));
    }
  }
  const summary = Object.fromEntries(modes.map((mode) => [mode, summarize(rowsByMode[mode])]));
  const hashes = new Set(Object.values(summary).flatMap((entry) => entry.resultHashes));
  if (hashes.size !== 1) throw new Error(`result hash disagreement in ${scenario}`);

  const wholeMemory = summary["whole-memory"];
  const streamedMemory = summary["streamed-memory"];
  const wholeTiming = summary["whole-timing"];
  const streamedTiming = summary["streamed-timing"];
  if (wholeMemory.totalMaterializedBytes.median !== streamedMemory.totalMaterializedBytes.median) {
    throw new Error(`total materialized bytes differ in ${scenario}`);
  }
  if (wholeTiming.totalMaterializedBytes.median !== streamedTiming.totalMaterializedBytes.median) {
    throw new Error(`timing modes materialized different bytes in ${scenario}`);
  }
  if (scenario === "report") {
    if (!(streamedMemory.declaredPeakLiveBodyBytes.median < wholeMemory.declaredPeakLiveBodyBytes.median)) {
      throw new Error("streamed declared report peak did not fall");
    }
    if (!(streamedMemory.measuredPeakArrayBufferDeltaBytes.median < wholeMemory.measuredPeakArrayBufferDeltaBytes.median)) {
      throw new Error("streamed measured ArrayBuffer report peak did not fall");
    }
  } else {
    if (streamedMemory.declaredPeakLiveBodyBytes.median !== wholeMemory.declaredPeakLiveBodyBytes.median) {
      throw new Error("single-body declared peak should be identical");
    }
  }

  console.log(JSON.stringify({
    schema: "axm.ignition-streamed-peak-comparison/v0.12",
    scenario,
    fileCount,
    samples,
    modes: summary,
    observedMedianDelta: {
      declaredPeakSavedBytes: wholeMemory.declaredPeakLiveBodyBytes.median - streamedMemory.declaredPeakLiveBodyBytes.median,
      measuredArrayBufferPeakSavedBytes: wholeMemory.measuredPeakArrayBufferDeltaBytes.median - streamedMemory.measuredPeakArrayBufferDeltaBytes.median,
      measuredExternalPeakSavedBytes: wholeMemory.measuredPeakExternalDeltaBytes.median - streamedMemory.measuredPeakExternalDeltaBytes.median,
      timingWholeMinusStreamedMs: wholeTiming.wallMs.median - streamedTiming.wallMs.median,
    },
    proofBoundary: {
      totalWork: "Whole-closure and streamed paths must materialize the same total runtime-body bytes and produce the same deterministic result hash.",
      physicalMemory: "ArrayBuffer peak is measured in fresh --expose-gc child processes with forced-GC lifecycle checkpoints. It demonstrates this harness's typed-array backing-store live set, not universal RSS behavior.",
      timing: "Timing samples run separately without forced-GC instrumentation so memory observation overhead does not contaminate orchestration timing.",
      counterexample: "The single-body scenario cannot reduce declared peak because total required runtime body equals the largest/only body.",
    },
  }));
}
