import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const probePath = fileURLToPath(new URL("./warm-probe.mjs", import.meta.url));
const fileCount = 2500;
const cases = [
  { scenario: "dependencies", repeats: 20 },
  { scenario: "search", repeats: 8 },
  { scenario: "report", repeats: 6 },
  { scenario: "breadth", repeats: 2 },
];
const modes = ["direct-cold", "ignition-cold", "ignition-warm", "eager-warm"];

function probe(mode, scenario, repeats) {
  const stdout = execFileSync(
    process.execPath,
    ["--expose-gc", probePath, mode, scenario, String(repeats), String(fileCount)],
    { encoding: "utf8" }
  );
  return JSON.parse(stdout.trim());
}

function cumulative(values) {
  const out = [];
  let total = 0;
  for (const value of values) {
    total += value;
    out.push(total);
  }
  return out;
}

function breakEvenIteration(candidate, baseline) {
  const a = cumulative(candidate);
  const b = cumulative(baseline);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] <= b[i]) return i + 1;
  }
  return null;
}

let failed = false;
for (const testCase of cases) {
  const results = Object.fromEntries(
    modes.map((mode) => [mode, probe(mode, testCase.scenario, testCase.repeats)])
  );
  const referenceHashes = JSON.stringify(results["direct-cold"].resultHashes);
  const allEquivalent = modes.every((mode) => JSON.stringify(results[mode].resultHashes) === referenceHashes);
  if (!allEquivalent) failed = true;

  const direct = results["direct-cold"];
  const ignitionCold = results["ignition-cold"];
  const ignitionWarm = results["ignition-warm"];
  const eagerWarm = results["eager-warm"];

  if (direct.totalMaterializedBytes !== ignitionCold.totalMaterializedBytes) failed = true;
  if (testCase.scenario === "dependencies") {
    if (!(ignitionWarm.finalCacheBytes < eagerWarm.finalCacheBytes)) failed = true;
    if (!(ignitionWarm.newBytesPerRun[0] > 0 && ignitionWarm.newBytesPerRun.slice(1).every((value) => value === 0))) failed = true;
  }
  if (testCase.scenario === "report") {
    if (ignitionWarm.finalCacheBytes !== eagerWarm.finalCacheBytes) failed = true;
  }
  if (testCase.scenario === "breadth") {
    if (ignitionWarm.finalCacheBytes !== eagerWarm.finalCacheBytes) failed = true;
  }

  console.log(JSON.stringify({
    schema: "axm.ignition-warm-comparison/v0.04",
    scenario: testCase.scenario,
    repeats: testCase.repeats,
    requestCount: direct.requestCount,
    allEquivalent,
    directCold: {
      totalElapsedMs: direct.totalElapsedMs,
      firstElapsedMs: direct.firstElapsedMs,
      laterMedianElapsedMs: direct.laterMedianElapsedMs,
      totalMaterializedBytes: direct.totalMaterializedBytes,
    },
    ignitionCold: {
      totalElapsedMs: ignitionCold.totalElapsedMs,
      firstElapsedMs: ignitionCold.firstElapsedMs,
      laterMedianElapsedMs: ignitionCold.laterMedianElapsedMs,
      totalMaterializedBytes: ignitionCold.totalMaterializedBytes,
    },
    ignitionWarm: {
      totalElapsedMs: ignitionWarm.totalElapsedMs,
      firstElapsedMs: ignitionWarm.firstElapsedMs,
      laterMedianElapsedMs: ignitionWarm.laterMedianElapsedMs,
      totalMaterializedBytes: ignitionWarm.totalMaterializedBytes,
      finalCacheBytes: ignitionWarm.finalCacheBytes,
    },
    eagerWarm: {
      totalElapsedMs: eagerWarm.totalElapsedMs,
      firstElapsedMs: eagerWarm.firstElapsedMs,
      laterMedianElapsedMs: eagerWarm.laterMedianElapsedMs,
      totalMaterializedBytes: eagerWarm.totalMaterializedBytes,
      finalCacheBytes: eagerWarm.finalCacheBytes,
    },
    observedBreakEvenIteration: {
      ignitionWarmVsDirectCold: breakEvenIteration(ignitionWarm.elapsedMsPerRun, direct.elapsedMsPerRun),
      ignitionWarmVsIgnitionCold: breakEvenIteration(ignitionWarm.elapsedMsPerRun, ignitionCold.elapsedMsPerRun),
      ignitionWarmVsEagerWarm: breakEvenIteration(ignitionWarm.elapsedMsPerRun, eagerWarm.elapsedMsPerRun),
    },
    timingBoundary: "Single hosted-run timings are observations, not statistical performance claims.",
  }));
}

if (failed) process.exitCode = 1;
