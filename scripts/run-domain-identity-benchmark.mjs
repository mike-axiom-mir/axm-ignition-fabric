import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const probePath = fileURLToPath(new URL("./domain-identity-probe.mjs", import.meta.url));
const samples = 5;
const transitionCount = 6;
const fileCount = 2500;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function runProbe(mode, scenario) {
  const stdout = execFileSync(
    process.execPath,
    [probePath, mode, scenario, String(transitionCount), String(fileCount)],
    { encoding: "utf8" }
  );
  return JSON.parse(stdout.trim());
}

function summarize(runs) {
  return {
    sampleCount: runs.length,
    allEquivalent: runs.every((run) => run.equivalent),
    runtimeWallMs: {
      median: median(runs.map((run) => run.runtimeWallMs)),
      min: Math.min(...runs.map((run) => run.runtimeWallMs)),
      max: Math.max(...runs.map((run) => run.runtimeWallMs)),
    },
    materializedBytesMedian: median(runs.map((run) => run.materializedBytes)),
    hitCountMedian: median(runs.map((run) => run.hitCount)),
    fullInvalidatedBytesMedian: median(runs.map((run) => run.fullInvalidatedBytes)),
    domainInvalidatedBytesMedian: median(runs.map((run) => run.domainInvalidatedBytes)),
    stateFingerprintBuildMs: {
      median: median(runs.map((run) => run.stateFingerprintBuildMs)),
      min: Math.min(...runs.map((run) => run.stateFingerprintBuildMs)),
      max: Math.max(...runs.map((run) => run.stateFingerprintBuildMs)),
    },
    domainIdentityBuildMs: {
      median: median(runs.map((run) => run.domainIdentityBuildMs)),
      min: Math.min(...runs.map((run) => run.domainIdentityBuildMs)),
      max: Math.max(...runs.map((run) => run.domainIdentityBuildMs)),
    },
    finalDomainRevisions: runs[0].finalDomainRevisions,
  };
}

let failed = false;
for (const scenario of ["path", "import"]) {
  const fullRuns = [];
  const domainRuns = [];
  for (let i = 0; i < samples; i += 1) {
    fullRuns.push(runProbe("full", scenario));
    domainRuns.push(runProbe("domain", scenario));
  }
  const full = summarize(fullRuns);
  const domain = summarize(domainRuns);
  if (!full.allEquivalent || !domain.allEquivalent) failed = true;

  console.log(JSON.stringify({
    schema: "axm.ignition-domain-identity-comparison/v0.09",
    scenario,
    fileCount,
    transitionCount,
    samples,
    full,
    domain,
    observedMedianDelta: {
      runtimeWallMs: full.runtimeWallMs.median - domain.runtimeWallMs.median,
      materializedBytes: full.materializedBytesMedian - domain.materializedBytesMedian,
      cacheHits: domain.hitCountMedian - full.hitCountMedian,
    },
    identityConstructionBoundary: {
      wholeStateFingerprintMedianMs: full.stateFingerprintBuildMs.median,
      domainIdentityMedianMs: domain.domainIdentityBuildMs.median,
      extraDomainIdentityConstructionMedianMs: domain.domainIdentityBuildMs.median - full.stateFingerprintBuildMs.median,
      interpretation: "Identity construction is reported separately and is not included in runtime timing. Current domain identity construction scans the full fixture and is not claimed cheap.",
    },
    timingBoundary: "Each sample runs in a fresh Node process. Runtime excludes direct verification and identity construction. Medians are from five hosted samples, not a broad statistical distribution.",
  }));
}
if (failed) process.exitCode = 1;
