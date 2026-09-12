import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const probePath = fileURLToPath(new URL("./retention-probe.mjs", import.meta.url));
const fileCount = 2500;
const policies = ["none", "lru", "value"];
const cases = [
  { scenario: "hot-search", budget: 900000 },
  { scenario: "low-reuse", budget: 900000 },
  { scenario: "alternating-small", budget: 60000 },
];

function probe(policy, scenario, budget) {
  const stdout = execFileSync(
    process.execPath,
    [probePath, policy, scenario, String(budget), String(fileCount)],
    { encoding: "utf8" }
  );
  return JSON.parse(stdout.trim());
}

let failed = false;
for (const testCase of cases) {
  const results = Object.fromEntries(
    policies.map((policy) => [policy, probe(policy, testCase.scenario, testCase.budget)])
  );
  const hashSequence = JSON.stringify(results.none.runs.map((run) => run.resultHash));
  const equivalent = policies.every((policy) =>
    results[policy].equivalent && JSON.stringify(results[policy].runs.map((run) => run.resultHash)) === hashSequence
  );
  if (!equivalent) failed = true;
  if (policies.some((policy) => results[policy].finalCacheBytes > testCase.budget)) failed = true;

  const ranking = policies
    .map((policy) => ({ policy, totalWallMs: results[policy].totalWallMs }))
    .sort((a, b) => a.totalWallMs - b.totalWallMs || a.policy.localeCompare(b.policy));

  const output = {
    schema: "axm.ignition-retention-comparison/v0.07",
    scenario: testCase.scenario,
    fileCount,
    maxCacheBytes: testCase.budget,
    equivalent,
    policies: Object.fromEntries(policies.map((policy) => [policy, {
      totalWallMs: results[policy].totalWallMs,
      totalMaterializedBytes: results[policy].totalMaterializedBytes,
      hitCount: results[policy].hitCount,
      missCount: results[policy].missCount,
      evictionCount: results[policy].evictionCount,
      finalCacheBytes: results[policy].finalCacheBytes,
      finalCachedCapabilityIds: results[policy].finalCachedCapabilityIds,
      evictionHistory: results[policy].evictionHistory,
    }])),
    observedFastestPolicy: ranking[0].policy,
    ranking,
    timingBoundary: "Each policy runs in a fresh Node process. Direct reference verification is excluded from policy timing. Single hosted samples are observational only.",
  };

  console.log(JSON.stringify(output));
}

if (failed) process.exitCode = 1;
