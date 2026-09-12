import { executeIgnitionRun } from "../src/ignition-core.js";
import { buildRealisticRegistry, buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";

const [mode = "ignition", scenario = "dependencies", countArg = "2500"] = process.argv.slice(2);
if (!["eager", "ignition"].includes(mode)) throw new Error("mode must be eager or ignition");
if (!(scenario in realisticRequests)) throw new Error(`unknown scenario: ${scenario}`);

const fileCount = Number(countArg);
if (!Number.isSafeInteger(fileCount) || fileCount < 100) throw new Error("fileCount must be an integer >= 100");

const state = buildWorkspaceState({ fileCount });
const registry = buildRealisticRegistry();

function memorySnapshot() {
  if (global.gc) global.gc();
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

const run = await executeIgnitionRun({
  registry,
  request: realisticRequests[scenario],
  state,
  mode,
  resourceProbe: memorySnapshot,
});

const before = run.receipt.resourceSnapshots.beforeMaterialize;
const after = run.receipt.resourceSnapshots.afterMaterialize;
const materializeMs = run.receipt.materializationReceipts.reduce((sum, item) => sum + item.elapsedMs, 0);
const executeMs = run.receipt.capabilityReceipts.reduce((sum, item) => sum + item.elapsedMs, 0);

console.log(JSON.stringify({
  schema: "axm.ignition-realistic-probe/v0.03",
  mode,
  scenario,
  fileCount,
  resultHash: run.receipt.resultHash,
  executedCapabilityIds: run.receipt.executedCapabilityIds,
  materializedCapabilityIds: run.receipt.materializedCapabilityIds,
  actualMaterializedBytes: run.receipt.actualMaterializedBytes,
  materializeMs,
  executeMs,
  totalElapsedMs: run.receipt.elapsedMs,
  memory: {
    beforeMaterialize: before,
    afterMaterialize: after,
    materializeDelta: {
      rss: after.rss - before.rss,
      heapUsed: after.heapUsed - before.heapUsed,
      external: after.external - before.external,
      arrayBuffers: after.arrayBuffers - before.arrayBuffers,
    },
  },
}));
