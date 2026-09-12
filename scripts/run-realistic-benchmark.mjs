import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const probePath = fileURLToPath(new URL("./realistic-probe.mjs", import.meta.url));
const scenarios = process.argv.slice(2);
const selected = scenarios.length ? scenarios : ["dependencies", "symbols", "search", "duplicates", "lint", "report"];
const fileCount = 2500;

function probe(mode, scenario) {
  const stdout = execFileSync(process.execPath, ["--expose-gc", probePath, mode, scenario, String(fileCount)], { encoding: "utf8" });
  return JSON.parse(stdout.trim());
}

let failed = false;
for (const scenario of selected) {
  const eager = probe("eager", scenario);
  const ignition = probe("ignition", scenario);
  const equivalent = eager.resultHash === ignition.resultHash;
  const actualSavedBytes = eager.actualMaterializedBytes - ignition.actualMaterializedBytes;
  const measuredArrayBufferBytesSaved = eager.memory.materializeDelta.arrayBuffers - ignition.memory.materializeDelta.arrayBuffers;

  const result = {
    schema: "axm.ignition-realistic-comparison/v0.03",
    scenario,
    fileCount,
    equivalent,
    eager: {
      materializedCount: eager.materializedCapabilityIds.length,
      actualMaterializedBytes: eager.actualMaterializedBytes,
      measuredArrayBufferDeltaBytes: eager.memory.materializeDelta.arrayBuffers,
      materializeMs: eager.materializeMs,
      executeMs: eager.executeMs,
      totalElapsedMs: eager.totalElapsedMs,
    },
    ignition: {
      materializedCount: ignition.materializedCapabilityIds.length,
      actualMaterializedBytes: ignition.actualMaterializedBytes,
      measuredArrayBufferDeltaBytes: ignition.memory.materializeDelta.arrayBuffers,
      materializeMs: ignition.materializeMs,
      executeMs: ignition.executeMs,
      totalElapsedMs: ignition.totalElapsedMs,
    },
    saved: { actualMaterializedBytes: actualSavedBytes, measuredArrayBufferBytesSaved },
  };

  console.log(JSON.stringify(result));
  if (!equivalent) failed = true;
  if (scenario !== "report" && !(actualSavedBytes > 0)) failed = true;
  if (scenario === "report" && actualSavedBytes !== 0) failed = true;
}

if (failed) process.exitCode = 1;
