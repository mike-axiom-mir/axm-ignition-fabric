import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { IgnitionGovernor } from "../src/ignition-governor.js";
import { runDirectRealisticBaseline } from "../src/direct-realistic-baseline.js";
import { buildRealisticRegistry, buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";

const warmProbePath = fileURLToPath(new URL("./warm-probe.mjs", import.meta.url));
const fileCount = 2500;

function fixedProbe(mode, scenario, repeats) {
  const stdout = execFileSync(
    process.execPath,
    ["--expose-gc", warmProbePath, mode, scenario, String(repeats), String(fileCount)],
    { encoding: "utf8" }
  );
  return JSON.parse(stdout.trim());
}

function counts(values) {
  const out = {};
  for (const value of values) out[value] = (out[value] || 0) + 1;
  return out;
}

async function runCase({ name, requests, states, cacheBudgetBytes, fixed = null }) {
  const registry = buildRealisticRegistry();
  const referenceRegistry = buildRealisticRegistry();
  const governor = new IgnitionGovernor({
    registry,
    directRunner: runDirectRealisticBaseline,
    cacheBudgetBytes,
  });

  const decisions = [];
  let equivalent = true;
  try {
    for (let i = 0; i < requests.length; i += 1) {
      const request = requests[i];
      const state = states[i];
      const governed = await governor.run({ request, state });
      const reference = await runDirectRealisticBaseline({ request, state, registry: referenceRegistry });
      if (governed.receipt.resultHash !== reference.receipt.resultHash) equivalent = false;
      decisions.push(governed.receipt);
    }

    let fixedObservation = null;
    if (fixed) {
      const direct = fixedProbe("direct-cold", fixed.scenario, fixed.repeats);
      const ignitionWarm = fixedProbe("ignition-warm", fixed.scenario, fixed.repeats);
      const eagerWarm = fixedProbe("eager-warm", fixed.scenario, fixed.repeats);
      const ranked = [
        ["direct-cold", direct.totalElapsedMs],
        ["ignition-warm", ignitionWarm.totalElapsedMs],
        ["eager-warm", eagerWarm.totalElapsedMs],
      ].sort((a, b) => a[1] - b[1]);
      fixedObservation = {
        directColdTotalMs: direct.totalElapsedMs,
        ignitionWarmTotalMs: ignitionWarm.totalElapsedMs,
        eagerWarmTotalMs: eagerWarm.totalElapsedMs,
        observedFastestFixedMode: ranked[0][0],
        timingBoundary: "Single hosted samples are observational only.",
      };
    }

    const result = {
      schema: "axm.ignition-governor-benchmark/v0.05",
      name,
      requestCount: requests.length,
      cacheBudgetBytes,
      equivalent,
      modeCounts: counts(decisions.map((decision) => decision.selectedMode)),
      reasonCounts: counts(decisions.map((decision) => decision.reason)),
      governorTotalElapsedMs: decisions.reduce((sum, decision) => sum + decision.elapsedMs, 0),
      finalRetainedCacheBytes: decisions.at(-1)?.retainedCacheBytes || 0,
      finalRetainedCapabilities: decisions.at(-1)?.retainedCacheCapabilityIds || [],
      decisions: decisions.map((decision) => ({
        runNumber: decision.runNumber,
        selectedMode: decision.selectedMode,
        reason: decision.reason,
        routeBreadth: decision.routeBreadth,
        predictedRouteBytes: decision.predictedRouteBytes,
        retainedCacheBytes: decision.retainedCacheBytes,
        stateChangeRate: decision.stateChangeRate,
        resultHash: decision.resultHash,
      })),
      fixedObservation,
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    await governor.close({ state: states.at(-1) });
  }
}

const stable = buildWorkspaceState({ fileCount });
const churnA = buildWorkspaceState({ fileCount: 700 });
const churnB = buildWorkspaceState({ fileCount: 701 });
const breadthCycle = [
  realisticRequests.dependencies,
  realisticRequests.symbols,
  realisticRequests.duplicates,
  realisticRequests.lint,
  realisticRequests.search,
  realisticRequests.report,
];

const cases = [
  {
    name: "narrow-repeat",
    requests: Array(12).fill(realisticRequests.dependencies),
    states: Array(12).fill(stable),
    cacheBudgetBytes: 100_000,
    fixed: { scenario: "dependencies", repeats: 12 },
  },
  {
    name: "search-tight-cache",
    requests: Array(5).fill(realisticRequests.search),
    states: Array(5).fill(stable),
    cacheBudgetBytes: 200_000,
    fixed: { scenario: "search", repeats: 5 },
  },
  {
    name: "report-high-cache",
    requests: Array(6).fill(realisticRequests.report),
    states: Array(6).fill(stable),
    cacheBudgetBytes: 2_000_000,
    fixed: { scenario: "report", repeats: 6 },
  },
  {
    name: "report-tight-cache",
    requests: Array(4).fill(realisticRequests.report),
    states: Array(4).fill(stable),
    cacheBudgetBytes: 500_000,
  },
  {
    name: "breadth-growth",
    requests: [...breadthCycle, ...breadthCycle],
    states: Array(12).fill(stable),
    cacheBudgetBytes: 2_000_000,
  },
  {
    name: "state-churn",
    requests: Array(8).fill(realisticRequests.dependencies),
    states: [churnA, churnB, churnA, churnB, churnA, churnB, churnA, churnB],
    cacheBudgetBytes: 100_000,
  },
];

let failed = false;
for (const testCase of cases) {
  const result = await runCase(testCase);
  if (!result.equivalent) failed = true;
}
if (failed) process.exitCode = 1;
