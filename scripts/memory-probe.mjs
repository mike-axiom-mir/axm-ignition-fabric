import { executeIgnitionRun } from "../src/ignition-core.js";
import { buildDemoRegistry, demoRequests } from "../src/demo-capabilities.js";

const [mode = "ignition", scenario = "numbers"] = process.argv.slice(2);
if (!["eager", "ignition"].includes(mode)) throw new Error(`unsupported mode: ${mode}`);
if (!(scenario in demoRequests)) throw new Error(`unknown scenario: ${scenario}`);
if (typeof global.gc !== "function") {
  throw new Error("memory-probe requires Node --expose-gc");
}

function memorySnapshot() {
  global.gc();
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

function subtract(left, right) {
  return Object.fromEntries(Object.keys(left).map((key) => [key, left[key] - right[key]]));
}

const run = await executeIgnitionRun({
  registry: buildDemoRegistry(),
  request: demoRequests[scenario],
  state: { answer: 42 },
  mode,
  resourceProbe: memorySnapshot,
});

const before = run.receipt.resourceSnapshots.beforeMaterialize;
const afterMaterialize = run.receipt.resourceSnapshots.afterMaterialize;
const afterRelease = run.receipt.resourceSnapshots.afterRelease;

console.log(JSON.stringify({
  schema: "axm.ignition-memory-probe/v0.02",
  mode,
  scenario,
  resultHash: run.receipt.resultHash,
  executedCapabilityIds: run.receipt.executedCapabilityIds,
  materializedCapabilityIds: run.receipt.materializedCapabilityIds,
  actualMaterializedBytes: run.receipt.actualMaterializedBytes,
  memory: {
    before,
    afterMaterialize,
    afterRelease,
    materializeDelta: subtract(afterMaterialize, before),
    retainedAfterReleaseDelta: subtract(afterRelease, before),
  },
}));
