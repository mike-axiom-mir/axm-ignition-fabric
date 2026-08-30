import { CapabilityRegistry, hashValue } from "./ignition-core.js";
import { validateTransitionReceipt } from "./scoped-invalidation.js";

function dependencyClosure(registry, initial) {
  const selected = new Map(initial.map((capability) => [capability.id, capability]));
  const queue = [...initial].sort((a, b) => a.id.localeCompare(b.id));
  while (queue.length) {
    const current = queue.shift();
    for (const depId of current.dependencies || []) {
      const dep = registry.get(depId);
      if (!dep) throw new Error(`missing dependency ${depId} required by ${current.id}`);
      if (!selected.has(depId)) { selected.set(depId, dep); queue.push(dep); queue.sort((a, b) => a.id.localeCompare(b.id)); }
    }
  }
  return [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function topoSort(capabilities) {
  const byId = new Map(capabilities.map((capability) => [capability.id, capability]));
  const indegree = new Map(capabilities.map((capability) => [capability.id, 0]));
  const outgoing = new Map(capabilities.map((capability) => [capability.id, []]));
  for (const capability of capabilities) for (const depId of capability.dependencies || []) if (byId.has(depId)) { indegree.set(capability.id, indegree.get(capability.id) + 1); outgoing.get(depId).push(capability.id); }
  const ready = capabilities.filter((capability) => indegree.get(capability.id) === 0).sort((a, b) => a.id.localeCompare(b.id));
  const ordered = [];
  while (ready.length) {
    const current = ready.shift(); ordered.push(current);
    for (const targetId of outgoing.get(current.id).sort()) { indegree.set(targetId, indegree.get(targetId) - 1); if (indegree.get(targetId) === 0) { ready.push(byId.get(targetId)); ready.sort((a, b) => a.id.localeCompare(b.id)); } }
  }
  if (ordered.length !== capabilities.length) throw new Error("capability dependency cycle detected");
  return ordered;
}

async function materialize(capability, context) {
  if (!capability.materialize) return { instance: null, allocatedBytes: 0 };
  const body = await capability.materialize(Object.freeze(context));
  if (!body || typeof body !== "object") throw new Error(`capability ${capability.id} materialize() must return an object`);
  const allocatedBytes = Number(body.allocatedBytes ?? 0);
  if (!Number.isSafeInteger(allocatedBytes) || allocatedBytes < 0) throw new Error(`capability ${capability.id} materialize() returned invalid allocatedBytes`);
  return { instance: body.instance ?? null, allocatedBytes };
}

export class IgnitionSession {
  constructor({ registry, mode = "ignition" }) {
    if (!(registry instanceof CapabilityRegistry)) throw new Error("registry must be CapabilityRegistry");
    if (!["ignition", "eager"].includes(mode)) throw new Error("mode must be ignition or eager");
    this.registry = registry; this.mode = mode; this.cache = new Map(); this.stateHash = null; this.closed = false;
  }
  get cacheBytes() { let total = 0; for (const entry of this.cache.values()) total += entry.allocatedBytes; return total; }
  get cachedCapabilityIds() { return [...this.cache.keys()].sort(); }

  async #releaseEntries(entries, { request = null, state = null } = {}) {
    let releasedBytes = 0;
    const releasedCapabilityIds = [];
    for (const [id, entry] of [...entries].reverse()) {
      const capability = this.registry.get(id);
      if (capability?.release) await capability.release(Object.freeze({ request, state, mode: this.mode, runtime: entry.instance }));
      releasedBytes += entry.allocatedBytes || 0;
      releasedCapabilityIds.push(id);
      this.cache.delete(id);
    }
    return { releasedBytes, releasedCapabilityIds: releasedCapabilityIds.sort() };
  }
  async releaseAll(context = {}) { const result = await this.#releaseEntries([...this.cache.entries()], context); this.stateHash = null; return result; }
  async close(context = {}) { if (this.closed) return; await this.releaseAll(context); this.closed = true; }

  async applyTransition({ transitionReceipt, invalidatedCapabilityIds = [], state = null }) {
    if (this.closed) throw new Error("IgnitionSession is closed");
    if (this.stateHash === null) throw new Error("cannot apply transition before session has a canonical state");
    validateTransitionReceipt(transitionReceipt, { expectedFrom: this.stateHash });
    const requested = [...new Set(invalidatedCapabilityIds)].sort();
    const entries = requested.filter((id) => this.cache.has(id)).map((id) => [id, this.cache.get(id)]);
    const released = await this.#releaseEntries(entries, { state });
    this.stateHash = transitionReceipt.toStateHash;
    return {
      schema: "axm.ignition-session-transition/v0.06",
      transitionReceiptHash: transitionReceipt.receiptHash,
      changedDomains: [...transitionReceipt.changedDomains],
      invalidatedCapabilityIds: requested,
      releasedCapabilityIds: released.releasedCapabilityIds,
      releasedBytes: released.releasedBytes,
      retainedCapabilityIds: this.cachedCapabilityIds,
      retainedBytes: this.cacheBytes,
      resultingStateHash: this.stateHash,
    };
  }

  async run({ request, state = {}, stateFingerprint = null }) {
    if (this.closed) throw new Error("IgnitionSession is closed");
    if (stateFingerprint !== null && typeof stateFingerprint !== "string") throw new Error("stateFingerprint must be a string or null");
    const nextStateHash = stateFingerprint ?? hashValue(state);
    let fallbackInvalidation = null;
    if (this.stateHash !== null && this.stateHash !== nextStateHash) {
      const released = await this.releaseAll({ request, state });
      fallbackInvalidation = { reason: "unreceipted-state-change", releasedCapabilityIds: released.releasedCapabilityIds, releasedBytes: released.releasedBytes };
    }
    this.stateHash = nextStateHash;

    const started = performance.now();
    const matched = this.registry.matched(request, state);
    const executable = dependencyClosure(this.registry, matched);
    const ordered = topoSort(executable);
    const target = this.mode === "eager" ? this.registry.all() : executable;
    const newlyMaterializedCapabilityIds = [], newMaterializationReceipts = [];
    let newlyMaterializedBytes = 0;
    const materializeStarted = performance.now();
    for (const capability of target) {
      if (this.cache.has(capability.id)) continue;
      const body = await materialize(capability, { request, state, mode: this.mode });
      this.cache.set(capability.id, body); newlyMaterializedCapabilityIds.push(capability.id); newlyMaterializedBytes += body.allocatedBytes;
      newMaterializationReceipts.push({ capabilityId: capability.id, allocatedBytes: body.allocatedBytes });
    }
    const materializeMs = performance.now() - materializeStarted;

    const outputs = {};
    const executeStarted = performance.now();
    for (const capability of ordered) {
      const dependencies = Object.fromEntries((capability.dependencies || []).filter((depId) => depId in outputs).map((depId) => [depId, outputs[depId]]));
      outputs[capability.id] = await capability.run(Object.freeze({ request, state, dependencies, runtime: this.cache.get(capability.id)?.instance ?? null }));
    }
    const executeMs = performance.now() - executeStarted;
    const result = Object.fromEntries(Object.keys(outputs).sort().map((id) => [id, outputs[id]]));
    return { result, receipt: {
      schema: "axm.ignition-session-run/v0.06", mode: this.mode, requestHash: hashValue(request), stateHash: nextStateHash,
      stateFingerprintReused: stateFingerprint !== null, fallbackInvalidation,
      matchedCapabilityIds: matched.map((capability) => capability.id), executedCapabilityIds: ordered.map((capability) => capability.id),
      newlyMaterializedCapabilityIds, newMaterializationReceipts, newlyMaterializedBytes,
      reusedCapabilityIds: target.filter((capability) => !newlyMaterializedCapabilityIds.includes(capability.id)).map((capability) => capability.id),
      cacheCapabilityIds: this.cachedCapabilityIds, cacheBytesAfter: this.cacheBytes,
      materializeMs, executeMs, totalElapsedMs: performance.now() - started, resultHash: hashValue(result)
    } };
  }
}
