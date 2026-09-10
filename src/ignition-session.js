import { AsyncLocalStorage } from "node:async_hooks";

import { CapabilityRegistry, hashValue } from "./ignition-core.js";
import { createDomainInvalidationResolver, validateTransitionReceipt } from "./scoped-invalidation.js";

const admittedOperationContext = new AsyncLocalStorage();

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

function normalizeCapabilityIds(capabilityIds, fieldName) {
  if (!Array.isArray(capabilityIds)) throw new Error(`${fieldName} must be an array`);
  if (capabilityIds.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error(`${fieldName} must contain non-empty strings`);
  }
  return [...new Set(capabilityIds)].sort();
}

function sameIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
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
  #closeInFlight = null;

  constructor({ registry, mode = "ignition", domainBindings = null }) {
    if (!(registry instanceof CapabilityRegistry)) throw new Error("registry must be CapabilityRegistry");
    if (!["ignition", "eager"].includes(mode)) throw new Error("mode must be ignition or eager");
    if (domainBindings !== null && (!domainBindings || typeof domainBindings !== "object" || Array.isArray(domainBindings))) {
      throw new Error("domainBindings must be an object or null");
    }
    this.registry = registry;
    this.mode = mode;
    this.cache = new Map();
    this.stateHash = null;
    this.closed = false;
    this.activeOperations = new Set();
    this.invalidationResolver = domainBindings === null ? null : createDomainInvalidationResolver(domainBindings);
  }
  get cacheBytes() { let total = 0; for (const entry of this.cache.values()) total += entry.allocatedBytes; return total; }
  get cachedCapabilityIds() { return [...this.cache.keys()].sort(); }

  #trackOperation(operation) {
    if (this.closed) return Promise.reject(new Error("IgnitionSession is closed"));
    if (this.activeOperations.size) {
      const error = new Error("IgnitionSession already has an admitted stateful operation");
      error.code = "AXM_SESSION_OPERATION_BUSY";
      return Promise.reject(error);
    }
    let settle;
    const settled = new Promise((resolve) => { settle = resolve; });
    this.activeOperations.add(settled);

    let result;
    try {
      result = admittedOperationContext.run({ session: this, settled }, operation);
    } catch (error) {
      this.activeOperations.delete(settled);
      settle();
      return Promise.reject(error);
    }

    return Promise.resolve(result).finally(() => {
      if (this.activeOperations.delete(settled)) settle();
    });
  }

  async #drainActiveOperations() {
    const active = [...this.activeOperations];
    if (active.length) await Promise.all(active);
  }

  async #releaseEntries(entries, { request = null, state = null } = {}) {
    let releasedBytes = 0;
    const releasedCapabilityIds = [];
    const failedCapabilityIds = [];
    const evictedCapabilityIds = [];
    const failures = [];
    for (const [id, entry] of [...entries].reverse()) {
      const capability = this.registry.get(id);
      try {
        if (capability?.release) await capability.release(Object.freeze({ request, state, mode: this.mode, runtime: entry.instance }));
        releasedBytes += entry.allocatedBytes || 0;
        releasedCapabilityIds.push(id);
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
        failedCapabilityIds.push(id);
      } finally {
        // A throwing release hook leaves runtime lifetime uncertain. Never retain an
        // entry after release was attempted: later execution must rematerialize it.
        this.cache.delete(id);
        evictedCapabilityIds.push(id);
      }
    }
    if (failures.length) {
      const error = new AggregateError(failures, "IgnitionSession release cleanup failed");
      error.code = "AXM_SESSION_RELEASE_FAILED";
      error.failedCapabilityIds = failedCapabilityIds.sort();
      error.evictedCapabilityIds = evictedCapabilityIds.sort();
      error.releasedCapabilityIds = releasedCapabilityIds.sort();
      throw error;
    }
    return { releasedBytes, releasedCapabilityIds: releasedCapabilityIds.sort() };
  }
  async releaseAll(context = {}) { const result = await this.#releaseEntries([...this.cache.entries()], context); this.stateHash = null; return result; }
  async close(context = {}) {
    const caller = admittedOperationContext.getStore();
    if (caller?.session === this && this.activeOperations.has(caller.settled)) {
      const error = new Error("IgnitionSession close() cannot be entered from work admitted by the same session");
      error.code = "AXM_SESSION_REENTRANT_CLOSE";
      throw error;
    }
    // Once terminal cleanup is in flight, every external close caller joins that exact
    // lifecycle instead of treating `closed` as evidence that cleanup already finished.
    if (this.#closeInFlight) return this.#closeInFlight;
    if (this.closed) return;

    // A close request revokes admission immediately. Operations that crossed the
    // boundary before this assignment retain only enough authority to settle; terminal
    // cleanup waits for them so their runtime/state changes cannot land after close.
    this.closed = true;
    const closeWork = (async () => {
      try {
        await this.#drainActiveOperations();
        await this.releaseAll(context);
      } finally {
        // Cleanup failure is still evidence that close did not finish cleanly, but it
        // must not revive the old canonical-session identity after authority was revoked.
        this.stateHash = null;
      }
    })();
    this.#closeInFlight = closeWork;

    try {
      return await closeWork;
    } finally {
      // In-flight callers share this outcome. After it settles, preserve the existing
      // terminal idempotency contract: later close() calls do not replay cleanup/failure.
      if (this.#closeInFlight === closeWork) this.#closeInFlight = null;
    }
  }

  async applyTransition(args) {
    return this.#trackOperation(() => this.#applyTransitionAdmitted(args));
  }

  async #applyTransitionAdmitted({ transitionReceipt, invalidatedCapabilityIds = null, state = null }) {
    if (this.stateHash === null) throw new Error("cannot apply transition before session has a canonical state");
    const expectedTo = state === null ? undefined : hashValue(state);
    validateTransitionReceipt(transitionReceipt, { expectedFrom: this.stateHash, expectedTo });

    let requested;
    let invalidationAuthority;
    if (this.invalidationResolver) {
      const resolution = this.invalidationResolver({
        transitionReceipt,
        cachedCapabilityIds: this.cachedCapabilityIds,
      });
      requested = resolution.invalidatedCapabilityIds;
      invalidationAuthority = "SESSION_DOMAIN_BINDINGS";

      if (invalidatedCapabilityIds !== null) {
        const supplied = normalizeCapabilityIds(invalidatedCapabilityIds, "invalidatedCapabilityIds");
        if (!sameIds(supplied, requested)) {
          throw new Error("invalidatedCapabilityIds mismatch session domain bindings");
        }
      }
    } else {
      if (invalidatedCapabilityIds !== null) {
        throw new Error("scoped invalidation requires session domainBindings");
      }
      requested = this.cachedCapabilityIds;
      invalidationAuthority = "FULL_CACHE_FALLBACK_NO_DOMAIN_BINDINGS";
    }

    const entries = requested.filter((id) => this.cache.has(id)).map((id) => [id, this.cache.get(id)]);
    const released = await this.#releaseEntries(entries, { state });
    this.stateHash = transitionReceipt.toStateHash;
    return {
      schema: "axm.ignition-session-transition/v0.06",
      transitionReceiptHash: transitionReceipt.receiptHash,
      changedDomains: [...transitionReceipt.changedDomains],
      invalidationAuthority,
      invalidatedCapabilityIds: [...requested],
      releasedCapabilityIds: released.releasedCapabilityIds,
      releasedBytes: released.releasedBytes,
      retainedCapabilityIds: this.cachedCapabilityIds,
      retainedBytes: this.cacheBytes,
      resultingStateHash: this.stateHash,
    };
  }

  async run(args) {
    return this.#trackOperation(() => this.#runAdmitted(args));
  }

  async #runAdmitted({ request, state = {}, stateFingerprint = null }) {
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