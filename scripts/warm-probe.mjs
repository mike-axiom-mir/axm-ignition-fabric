import { executeIgnitionRun } from "../src/ignition-core.js";
import { IgnitionSession } from "../src/ignition-session.js";
import { runDirectRealisticBaseline } from "../src/direct-realistic-baseline.js";
import { buildRealisticRegistry, buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";

const mode = process.argv[2] || "ignition-warm";
const scenario = process.argv[3] || "dependencies";
const repeats = Number(process.argv[4] || 12);
const fileCount = Number(process.argv[5] || 2500);

if (!["direct-cold", "ignition-cold", "ignition-warm", "eager-warm"].includes(mode)) {
  throw new Error(`unsupported mode: ${mode}`);
}
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 100) throw new Error("repeats must be 1..100");
if (!Number.isInteger(fileCount) || fileCount < 10) throw new Error("fileCount must be >= 10");

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function requestSequence() {
  if (scenario !== "breadth") {
    const request = realisticRequests[scenario];
    if (!request) throw new Error(`unknown scenario: ${scenario}`);
    return Array.from({ length: repeats }, () => request);
  }
  const cycle = [
    realisticRequests.dependencies,
    realisticRequests.symbols,
    realisticRequests.duplicates,
    realisticRequests.lint,
    realisticRequests.search,
    realisticRequests.report,
  ];
  return Array.from({ length: repeats }, () => cycle).flat();
}

const state = buildWorkspaceState({ fileCount });
const registry = buildRealisticRegistry();
const sequence = requestSequence();
const session = mode === "ignition-warm"
  ? new IgnitionSession({ registry, mode: "ignition" })
  : mode === "eager-warm"
    ? new IgnitionSession({ registry, mode: "eager" })
    : null;

if (global.gc) global.gc();
const before = process.memoryUsage();
const runs = [];
let totalMaterializedBytes = 0;

try {
  for (const request of sequence) {
    let outcome;
    if (mode === "direct-cold") {
      outcome = await runDirectRealisticBaseline({ request, state, registry });
      totalMaterializedBytes += outcome.receipt.actualMaterializedBytes;
      runs.push({
        kind: request.kind,
        elapsedMs: outcome.receipt.totalElapsedMs,
        materializeMs: outcome.receipt.materializeMs,
        executeMs: outcome.receipt.executeMs,
        newlyMaterializedBytes: outcome.receipt.actualMaterializedBytes,
        cacheBytesAfter: 0,
        resultHash: outcome.receipt.resultHash,
      });
    } else if (mode === "ignition-cold") {
      outcome = await executeIgnitionRun({ registry, request, state, mode: "ignition" });
      totalMaterializedBytes += outcome.receipt.actualMaterializedBytes;
      runs.push({
        kind: request.kind,
        elapsedMs: outcome.receipt.elapsedMs,
        materializeMs: outcome.receipt.materializationReceipts.reduce((sum, receipt) => sum + receipt.elapsedMs, 0),
        executeMs: outcome.receipt.capabilityReceipts.reduce((sum, receipt) => sum + receipt.elapsedMs, 0),
        newlyMaterializedBytes: outcome.receipt.actualMaterializedBytes,
        cacheBytesAfter: 0,
        resultHash: outcome.receipt.resultHash,
      });
    } else {
      outcome = await session.run({ request, state });
      totalMaterializedBytes += outcome.receipt.newlyMaterializedBytes;
      runs.push({
        kind: request.kind,
        elapsedMs: outcome.receipt.totalElapsedMs,
        materializeMs: outcome.receipt.materializeMs,
        executeMs: outcome.receipt.executeMs,
        newlyMaterializedBytes: outcome.receipt.newlyMaterializedBytes,
        cacheBytesAfter: outcome.receipt.cacheBytesAfter,
        resultHash: outcome.receipt.resultHash,
      });
    }
  }

  if (global.gc) global.gc();
  const afterWarm = process.memoryUsage();
  const elapsed = runs.map((run) => run.elapsedMs);
  const laterElapsed = elapsed.slice(1);

  console.log(JSON.stringify({
    schema: "axm.ignition-warm-probe/v0.04",
    mode,
    scenario,
    fileCount,
    requestCount: runs.length,
    resultHashes: runs.map((run) => run.resultHash),
    totalElapsedMs: elapsed.reduce((sum, value) => sum + value, 0),
    firstElapsedMs: elapsed[0],
    laterMedianElapsedMs: median(laterElapsed),
    totalMaterializedBytes,
    finalCacheBytes: session?.cacheBytes || 0,
    finalCachedCapabilityIds: session?.cachedCapabilityIds || [],
    newBytesPerRun: runs.map((run) => run.newlyMaterializedBytes),
    elapsedMsPerRun: elapsed,
    memoryObservation: {
      arrayBuffersDelta: afterWarm.arrayBuffers - before.arrayBuffers,
      externalDelta: afterWarm.external - before.external,
      rssDelta: afterWarm.rss - before.rss,
      heapUsedDelta: afterWarm.heapUsed - before.heapUsed,
    },
  }));
} finally {
  if (session) await session.close({ state });
}
