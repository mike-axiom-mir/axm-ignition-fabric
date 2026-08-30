import { execFileSync } from "node:child_process";

const scenarios = process.argv.slice(2);
const selected = scenarios.length ? scenarios : ["numbers", "text", "lookup", "mixed", "heavy"];

function runProbe(mode, scenario) {
  const stdout = execFileSync(
    process.execPath,
    ["--expose-gc", new URL("./memory-probe.mjs", import.meta.url).pathname, mode, scenario],
    { encoding: "utf8" }
  );
  return JSON.parse(stdout.trim());
}

let failed = false;
for (const scenario of selected) {
  const eager = runProbe("eager", scenario);
  const ignition = runProbe("ignition", scenario);
  const equivalent = eager.resultHash === ignition.resultHash;
  const eagerArrayBufferDelta = eager.memory.materializeDelta.arrayBuffers;
  const ignitionArrayBufferDelta = ignition.memory.materializeDelta.arrayBuffers;
  const reduced = ignitionArrayBufferDelta < eagerArrayBufferDelta;

  const result = {
    schema: "axm.ignition-memory-comparison/v0.02",
    scenario,
    equivalent,
    eager: {
      materializedCount: eager.materializedCapabilityIds.length,
      actualMaterializedBytes: eager.actualMaterializedBytes,
      arrayBufferDeltaBytes: eagerArrayBufferDelta,
      externalDeltaBytes: eager.memory.materializeDelta.external,
      rssDeltaBytes: eager.memory.materializeDelta.rss,
    },
    ignition: {
      materializedCount: ignition.materializedCapabilityIds.length,
      actualMaterializedBytes: ignition.actualMaterializedBytes,
      arrayBufferDeltaBytes: ignitionArrayBufferDelta,
      externalDeltaBytes: ignition.memory.materializeDelta.external,
      rssDeltaBytes: ignition.memory.materializeDelta.rss,
    },
    saved: {
      materializedBytes: eager.actualMaterializedBytes - ignition.actualMaterializedBytes,
      measuredArrayBufferBytes: eagerArrayBufferDelta - ignitionArrayBufferDelta,
    },
  };

  console.log(JSON.stringify(result));
  if (!equivalent || !reduced) failed = true;
}

if (failed) process.exitCode = 1;
