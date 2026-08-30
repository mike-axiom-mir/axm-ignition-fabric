export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function fnv1a32(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function hashValue(value) {
  return fnv1a32(stableStringify(value));
}

export class CapabilityRegistry {
  constructor(capabilities = []) {
    this.capabilities = new Map();
    capabilities.forEach((capability) => this.register(capability));
  }

  register(capability) {
    if (!capability?.id) throw new Error("capability.id is required");
    if (this.capabilities.has(capability.id)) throw new Error(`duplicate capability: ${capability.id}`);
    if (typeof capability.match !== "function") throw new Error(`capability ${capability.id} requires match()`);
    if (typeof capability.run !== "function") throw new Error(`capability ${capability.id} requires run()`);
    if (capability.materialize && typeof capability.materialize !== "function") {
      throw new Error(`capability ${capability.id} materialize must be a function`);
    }
    if (capability.release && typeof capability.release !== "function") {
      throw new Error(`capability ${capability.id} release must be a function`);
    }
    this.capabilities.set(capability.id, Object.freeze({
      deterministic: true,
      dependencies: [],
      resourceEstimateBytes: 0,
      ...capability,
      dependencies: [...(capability.dependencies || [])].sort(),
    }));
  }

  all() {
    return [...this.capabilities.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id) {
    return this.capabilities.get(id);
  }

  matched(request, state) {
    return this.all().filter((capability) => capability.match(request, state));
  }
}

function dependencyClosure(registry, initial) {
  const selected = new Map(initial.map((capability) => [capability.id, capability]));
  const queue = [...initial].sort((a, b) => a.id.localeCompare(b.id));
  while (queue.length) {
    const current = queue.shift();
    for (const depId of current.dependencies) {
      const dep = registry.get(depId);
      if (!dep) throw new Error(`missing dependency ${depId} required by ${current.id}`);
      if (!selected.has(dep.id)) {
        selected.set(dep.id, dep);
        queue.push(dep);
        queue.sort((a, b) => a.id.localeCompare(b.id));
      }
    }
  }
  return [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function topoSort(capabilities) {
  const byId = new Map(capabilities.map((capability) => [capability.id, capability]));
  const indegree = new Map(capabilities.map((capability) => [capability.id, 0]));
  const outgoing = new Map(capabilities.map((capability) => [capability.id, []]));

  for (const capability of capabilities) {
    for (const depId of capability.dependencies) {
      if (!byId.has(depId)) continue;
      indegree.set(capability.id, indegree.get(capability.id) + 1);
      outgoing.get(depId).push(capability.id);
    }
  }

  const ready = [...capabilities.filter((capability) => indegree.get(capability.id) === 0)]
    .sort((a, b) => a.id.localeCompare(b.id));
  const ordered = [];

  while (ready.length) {
    const current = ready.shift();
    ordered.push(current);
    for (const targetId of outgoing.get(current.id).sort()) {
      indegree.set(targetId, indegree.get(targetId) - 1);
      if (indegree.get(targetId) === 0) {
        ready.push(byId.get(targetId));
        ready.sort((a, b) => a.id.localeCompare(b.id));
      }
    }
  }

  if (ordered.length !== capabilities.length) throw new Error("capability dependency cycle detected");
  return ordered;
}

function planRun(registry, request, state, mode) {
  const matched = registry.matched(request, state);
  const executable = dependencyClosure(registry, matched);
  const materialized = mode === "eager" ? registry.all() : executable;
  return { matched, executable, materialized };
}

async function takeResourceSnapshot(resourceProbe, phase, details = {}) {
  if (!resourceProbe) return null;
  const value = await resourceProbe(Object.freeze({ phase, ...details }));
  return value == null ? null : structuredClone(value);
}

async function materializeCapability(capability, context) {
  const started = performance.now();
  if (!capability.materialize) {
    return {
      instance: null,
      receipt: {
        capabilityId: capability.id,
        allocatedBytes: 0,
        elapsedMs: performance.now() - started,
      },
    };
  }

  const materialized = await capability.materialize(Object.freeze(context));
  if (!materialized || typeof materialized !== "object") {
    throw new Error(`capability ${capability.id} materialize() must return an object`);
  }
  const allocatedBytes = Number(materialized.allocatedBytes ?? 0);
  if (!Number.isSafeInteger(allocatedBytes) || allocatedBytes < 0) {
    throw new Error(`capability ${capability.id} materialize() returned invalid allocatedBytes`);
  }

  return {
    instance: materialized.instance ?? null,
    receipt: {
      capabilityId: capability.id,
      allocatedBytes,
      elapsedMs: performance.now() - started,
    },
  };
}

export async function executeIgnitionRun({
  registry,
  request,
  state = {},
  mode = "ignition",
  resourceProbe = null,
}) {
  if (!(registry instanceof CapabilityRegistry)) throw new Error("registry must be CapabilityRegistry");
  if (!["ignition", "eager"].includes(mode)) throw new Error("mode must be ignition or eager");
  if (resourceProbe && typeof resourceProbe !== "function") throw new Error("resourceProbe must be a function");

  const runId = `run-${hashValue({ request, state, mode })}`;
  const plan = planRun(registry, request, state, mode);
  const ordered = topoSort(plan.executable);
  const started = performance.now();
  const outputs = {};
  const capabilityReceipts = [];
  const materializationReceipts = [];
  const runtimeById = new Map();
  const resourceSnapshots = {};
  let releaseError = null;

  resourceSnapshots.beforeMaterialize = await takeResourceSnapshot(resourceProbe, "beforeMaterialize", {
    mode,
    materializedCapabilityIds: plan.materialized.map((capability) => capability.id),
  });

  try {
    for (const capability of plan.materialized) {
      const { instance, receipt } = await materializeCapability(capability, { request, state, mode });
      runtimeById.set(capability.id, instance);
      materializationReceipts.push(receipt);
    }

    resourceSnapshots.afterMaterialize = await takeResourceSnapshot(resourceProbe, "afterMaterialize", {
      mode,
      materializedCapabilityIds: plan.materialized.map((capability) => capability.id),
    });

    for (const capability of ordered) {
      const capStarted = performance.now();
      const dependencies = Object.fromEntries(
        capability.dependencies
          .filter((depId) => depId in outputs)
          .map((depId) => [depId, outputs[depId]])
      );
      const output = await capability.run(Object.freeze({
        request,
        state,
        dependencies,
        runtime: runtimeById.get(capability.id),
      }));
      outputs[capability.id] = output;
      capabilityReceipts.push({
        capabilityId: capability.id,
        dependencies: capability.dependencies,
        outputHash: hashValue(output),
        elapsedMs: performance.now() - capStarted,
        resourceEstimateBytes: capability.resourceEstimateBytes,
      });
    }
  } finally {
    for (const capability of [...plan.materialized].reverse()) {
      try {
        if (capability.release) {
          await capability.release(Object.freeze({
            request,
            state,
            mode,
            runtime: runtimeById.get(capability.id),
          }));
        }
      } catch (error) {
        releaseError ??= error;
      }
      runtimeById.delete(capability.id);
    }
    resourceSnapshots.afterRelease = await takeResourceSnapshot(resourceProbe, "afterRelease", {
      mode,
      releasedCapabilityIds: plan.materialized.map((capability) => capability.id),
    });
  }

  if (releaseError) throw releaseError;

  const merged = Object.fromEntries(Object.keys(outputs).sort().map((key) => [key, outputs[key]]));
  const actualMaterializedBytes = materializationReceipts.reduce((sum, receipt) => sum + receipt.allocatedBytes, 0);
  const receipt = {
    schema: "axm.ignition-run/v0.02",
    runId,
    mode,
    requestHash: hashValue(request),
    stateHash: hashValue(state),
    matchedCapabilityIds: plan.matched.map((capability) => capability.id),
    executedCapabilityIds: ordered.map((capability) => capability.id),
    materializedCapabilityIds: plan.materialized.map((capability) => capability.id),
    materializedCount: plan.materialized.length,
    executedCount: ordered.length,
    estimatedWorkingSetBytes: plan.materialized.reduce((sum, capability) => sum + capability.resourceEstimateBytes, 0),
    actualMaterializedBytes,
    materializationReceipts,
    capabilityReceipts,
    resourceSnapshots,
    resultHash: hashValue(merged),
    elapsedMs: performance.now() - started,
    releasedCapabilityIds: plan.materialized.map((capability) => capability.id),
  };

  return { result: merged, receipt };
}

export function compareEquivalentRuns(a, b) {
  return {
    equivalent: hashValue(a.result) === hashValue(b.result),
    leftHash: hashValue(a.result),
    rightHash: hashValue(b.result),
    estimatedWorkingSetDeltaBytes: a.receipt.estimatedWorkingSetBytes - b.receipt.estimatedWorkingSetBytes,
    actualMaterializedDeltaBytes: a.receipt.actualMaterializedBytes - b.receipt.actualMaterializedBytes,
    materializedCountDelta: a.receipt.materializedCount - b.receipt.materializedCount,
    executedCountDelta: a.receipt.executedCount - b.receipt.executedCount,
  };
}
