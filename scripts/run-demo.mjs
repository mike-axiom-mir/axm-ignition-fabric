import { compareEquivalentRuns, executeIgnitionRun } from "../src/ignition-core.js";
import { buildDemoRegistry, demoRequests } from "../src/demo-capabilities.js";

const state = { answer: 42 };

for (const [name, request] of Object.entries(demoRequests)) {
  const registry = buildDemoRegistry();
  const eager = await executeIgnitionRun({ registry, request, state, mode: "eager" });
  const ignition = await executeIgnitionRun({ registry, request, state, mode: "ignition" });
  const comparison = compareEquivalentRuns(eager, ignition);

  console.log(JSON.stringify({
    schema: "axm.ignition-demo/v0.02",
    scenario: name,
    equivalent: comparison.equivalent,
    eagerMaterialized: eager.receipt.materializedCount,
    ignitionMaterialized: ignition.receipt.materializedCount,
    eagerActualMaterializedBytes: eager.receipt.actualMaterializedBytes,
    ignitionActualMaterializedBytes: ignition.receipt.actualMaterializedBytes,
    actualMaterializedSavingsBytes: comparison.actualMaterializedDeltaBytes,
    executedCapabilityIds: ignition.receipt.executedCapabilityIds,
    resultHash: ignition.receipt.resultHash,
  }));
}
