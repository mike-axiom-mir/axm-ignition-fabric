import { hashValue } from "./ignition-core.js";
import { buildRealisticRegistry } from "./realistic-workload.js";

const DIRECT_ROUTES = {
  dependencies: ["workspace-dependency-index"], symbols: ["workspace-symbol-index"], search: ["workspace-search-index"],
  duplicates: ["workspace-duplicate-index"], lint: ["workspace-lint-index"], metadata: ["workspace-metadata-index"],
  report: ["workspace-dependency-index", "workspace-duplicate-index", "workspace-lint-index", "workspace-metadata-index", "workspace-search-index", "workspace-symbol-index", "workspace-report-projection"]
};

export async function runDirectRealisticBaseline({ request, state, registry = buildRealisticRegistry(), stateFingerprint = null }) {
  if (stateFingerprint !== null && typeof stateFingerprint !== "string") throw new Error("stateFingerprint must be a string or null");
  const route = DIRECT_ROUTES[request.kind];
  if (!route) throw new Error(`unsupported direct request kind: ${request.kind}`);
  const started = performance.now(), runtimes = new Map(), outputs = {};
  let allocatedBytes = 0, materializeMs = 0, executeMs = 0, result = null;
  try {
    const materializeStarted = performance.now();
    for (const id of route) {
      const capability = registry.get(id);
      if (!capability) throw new Error(`missing direct capability ${id}`);
      if (!capability.materialize) { runtimes.set(id, null); continue; }
      const body = await capability.materialize(Object.freeze({ request, state, mode: "direct" }));
      const bytes = Number(body?.allocatedBytes ?? 0);
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`invalid direct allocatedBytes from ${id}`);
      allocatedBytes += bytes; runtimes.set(id, body?.instance ?? null);
    }
    materializeMs = performance.now() - materializeStarted;
    const executeStarted = performance.now();
    for (const id of route) {
      const capability = registry.get(id);
      const dependencies = Object.fromEntries((capability.dependencies || []).filter((depId) => depId in outputs).map((depId) => [depId, outputs[depId]]));
      outputs[id] = await capability.run(Object.freeze({ request, state, dependencies, runtime: runtimes.get(id) ?? null }));
    }
    executeMs = performance.now() - executeStarted;
    result = Object.fromEntries(Object.keys(outputs).sort().map((id) => [id, outputs[id]]));
  } finally {
    for (const id of [...route].reverse()) {
      const capability = registry.get(id);
      if (capability?.release) await capability.release(Object.freeze({ request, state, mode: "direct", runtime: runtimes.get(id) ?? null }));
      runtimes.delete(id);
    }
  }
  return { result, receipt: {
    schema: "axm.direct-realistic-run/v0.05", requestHash: hashValue(request), stateHash: stateFingerprint ?? hashValue(state),
    stateFingerprintReused: stateFingerprint !== null, route, actualMaterializedBytes: allocatedBytes, materializeMs, executeMs,
    totalElapsedMs: performance.now() - started, resultHash: hashValue(result)
  } };
}
