import { CapabilityRegistry, hashValue } from "./ignition-core.js";
import { bodyIdentity, validateDomainIdentity } from "./domain-identity.js";

function dependencyClosure(registry, initial) {
  const selected = new Map(initial.map((capability) => [capability.id, capability]));
  const queue = [...initial].sort((a, b) => a.id.localeCompare(b.id));
  while (queue.length) {
    const current = queue.shift();
    for (const depId of current.dependencies || []) {
      const dep = registry.get(depId);
      if (!dep) throw new Error(`missing dependency ${depId} required by ${current.id}`);
      if (!selected.has(depId)) {
        selected.set(depId, dep);
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
    for (const depId of capability.dependencies || []) {
      if (!byId.has(depId)) continue;
      indegree.set(capability.id, indegree.get(capability.id) + 1);
      outgoing.get(depId).push(capability.id);
    }
  }
  const ready = capabilities
    .filter((capability) => indegree.get(capability.id) === 0)
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

function normalizeDomainBindings(bindings) {
  const out = new Map();
  for (const [capabilityId, domains] of Object.entries(bindings || {})) {
    out.set(capabilityId, [...new Set(domains || [])].sort());
  }
  return out;
}

function candidateOrder(entries, policy) {
  return [...entries].sort((a, b) => {
    if (policy === "lru") {
      return a[1].lastUsedRun - b[1].lastUsedRun || a[0].localeCompare(b[0]);
    }
    if (policy === "value") {
      const aUnits = Math.max(1, a[1].allocatedBytes / 65536);
      const bUnits = Math.max(1, b[1].allocatedBytes / 65536);
      const aScore = (a[1].materializeMs * Math.max(1, a[1].hitCount)) / aUnits;
      const bScore = (b[1].materializeMs * Math.max(1, b[1].hitCount)) / bUnits;
      return aScore - bScore || a[1].lastUsedRun - b[1].lastUsedRun || a[0].localeCompare(b[0]);
    }
    throw new Error(`unknown workset policy: ${policy}`);
  });
}

export class BudgetedWorksetSession {
  constructor({ registry, maxCacheBytes, policy = "value", domainBindings = null }) {
    if (!(registry instanceof CapabilityRegistry)) throw new Error("registry must be CapabilityRegistry");
    if (!Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 0) throw new Error("maxCacheBytes must be a non-negative safe integer");
    if (!["none", "lru", "value"].includes(policy)) throw new Error("policy must be none, lru, or value");
    this.registry = registry;
    this.maxCacheBytes = maxCacheBytes;
    this.policy = policy;
    this.domainBindings = normalizeDomainBindings(domainBindings);
    this.cache = new Map();
    this.stateHash = null;
    this.domainIdentity = null;
    this.runNumber = 0;
    this.closed = false;
    this.evictionHistory = [];
  }

  get cacheBytes() {
    let total = 0;
    for (const entry of this.cache.values()) total += entry.allocatedBytes;
    return total;
  }

  get cachedCapabilityIds() {
    return [...this.cache.keys()].sort();
  }

  async #releaseRuntime(capabilityId, entry, context, reason) {
    if (!entry || entry.released) return null;
    const capability = this.registry.get(capabilityId);
    if (capability?.release) {
      await capability.release(Object.freeze({
        request: context.request ?? null,
        state: context.state ?? null,
        mode: `workset-${this.policy}`,
        runtime: entry.instance,
      }));
    }
    entry.released = true;
    const receipt = {
      capabilityId,
      allocatedBytes: entry.allocatedBytes,
      hitCount: entry.hitCount,
      materializeMs: entry.materializeMs,
      lastUsedRun: entry.lastUsedRun,
      sourceDomains: entry.sourceDomains || null,
      bodyIdentityHash: entry.bodyIdentityHash || null,
      reason,
    };
    return receipt;
  }

  async #releaseCacheEntry(capabilityId, context, reason) {
    const entry = this.cache.get(capabilityId);
    if (!entry) return null;
    this.cache.delete(capabilityId);
    const receipt = await this.#releaseRuntime(capabilityId, entry, context, reason);
    if (receipt) this.evictionHistory.push(receipt);
    return receipt;
  }

  async #releaseCacheIds(ids, context, reason) {
    const receipts = [];
    for (const id of [...new Set(ids || [])].sort()) {
      const receipt = await this.#releaseCacheEntry(id, context, reason);
      if (receipt) receipts.push(receipt);
    }
    return receipts;
  }

  async releaseAll(context = {}, reason = "release-all") {
    const receipts = await this.#releaseCacheIds(this.cachedCapabilityIds, context, reason);
    this.stateHash = null;
    this.domainIdentity = null;
    return receipts;
  }

  async close(context = {}) {
    if (this.closed) return;
    await this.releaseAll(context, "session-close");
    this.closed = true;
  }

  async #reconcileDomainIdentity(nextIdentity, context) {
    validateDomainIdentity(nextIdentity);
    const released = [];
    if (this.domainIdentity === null) {
      if (this.cache.size) {
        released.push(...await this.#releaseCacheIds(this.cachedCapabilityIds, context, "domain-identity-adoption"));
      }
      this.domainIdentity = nextIdentity;
      this.stateHash = nextIdentity.stateHash;
      return released;
    }
    if (this.domainIdentity.identityHash === nextIdentity.identityHash) {
      this.stateHash = nextIdentity.stateHash;
      return released;
    }

    for (const id of this.cachedCapabilityIds) {
      const entry = this.cache.get(id);
      if (!entry?.sourceDomains?.length || !entry.bodyIdentityHash) {
        const receipt = await this.#releaseCacheEntry(id, context, "domain-identity-unbound");
        if (receipt) released.push(receipt);
        continue;
      }
      let current = null;
      try {
        current = bodyIdentity({ capabilityId: id, identity: nextIdentity, domains: entry.sourceDomains });
      } catch {
        current = null;
      }
      if (!current || current.bodyIdentityHash !== entry.bodyIdentityHash) {
        const receipt = await this.#releaseCacheEntry(id, context, "domain-identity-change");
        if (receipt) released.push(receipt);
      }
    }
    this.domainIdentity = nextIdentity;
    this.stateHash = nextIdentity.stateHash;
    return released;
  }

  async #evictToBudget(context) {
    const evicted = [];
    if (this.policy === "none") return evicted;
    while (this.cacheBytes > this.maxCacheBytes) {
      const candidates = candidateOrder([...this.cache.entries()], this.policy);
      if (!candidates.length) break;
      const receipt = await this.#releaseCacheEntry(candidates[0][0], context, "budget");
      if (receipt) evicted.push(receipt);
    }
    return evicted;
  }

  async #materialize(capability, { request, state, domainIdentity }) {
    const started = performance.now();
    const body = capability.materialize
      ? await capability.materialize(Object.freeze({ request, state, mode: `workset-${this.policy}` }))
      : { instance: null, allocatedBytes: 0 };
    const allocatedBytes = Number(body?.allocatedBytes ?? 0);
    if (!Number.isSafeInteger(allocatedBytes) || allocatedBytes < 0) {
      throw new Error(`invalid allocatedBytes from ${capability.id}`);
    }
    const sourceDomains = this.domainBindings.get(capability.id) || null;
    const identityReceipt = domainIdentity && sourceDomains?.length
      ? bodyIdentity({ capabilityId: capability.id, identity: domainIdentity, domains: sourceDomains })
      : null;
    return {
      instance: body?.instance ?? null,
      allocatedBytes,
      materializeMs: performance.now() - started,
      hitCount: 0,
      lastUsedRun: this.runNumber,
      sourceDomains,
      bodyIdentityHash: identityReceipt?.bodyIdentityHash || null,
      validityKey: identityReceipt?.validityKey || null,
      released: false,
    };
  }

  async run({ request, state = {}, stateFingerprint = null, domainIdentity = null }) {
    if (this.closed) throw new Error("BudgetedWorksetSession is closed");
    if (stateFingerprint !== null && typeof stateFingerprint !== "string") throw new Error("stateFingerprint must be a string or null");
    if (domainIdentity) {
      validateDomainIdentity(domainIdentity);
      if (stateFingerprint !== null && stateFingerprint !== domainIdentity.stateHash) {
        throw new Error("stateFingerprint does not match domain identity stateHash");
      }
    }

    const stateHash = domainIdentity?.stateHash ?? stateFingerprint ?? hashValue(state);
    let invalidatedForStateChange = [];
    let invalidatedForDomainIdentity = [];
    if (domainIdentity) {
      invalidatedForDomainIdentity = await this.#reconcileDomainIdentity(domainIdentity, { request, state });
    } else {
      if (this.stateHash !== null && this.stateHash !== stateHash) {
        invalidatedForStateChange = await this.releaseAll({ request, state }, "unreceipted-state-change");
      }
      this.stateHash = stateHash;
      this.domainIdentity = null;
    }

    this.runNumber += 1;
    const matched = this.registry.matched(request, state);
    const closure = dependencyClosure(this.registry, matched);
    const ordered = topoSort(closure);
    const runtimeById = new Map();
    const entriesById = new Map();
    const cacheHitCapabilityIds = [];
    const materializedCapabilityIds = [];
    const materializationReceipts = [];
    let newlyMaterializedBytes = 0;
    let closureBodyBytes = 0;

    for (const capability of ordered) {
      const cached = this.cache.get(capability.id);
      if (cached) {
        cached.hitCount += 1;
        cached.lastUsedRun = this.runNumber;
        runtimeById.set(capability.id, cached.instance);
        entriesById.set(capability.id, cached);
        cacheHitCapabilityIds.push(capability.id);
        closureBodyBytes += cached.allocatedBytes;
        continue;
      }
      const entry = await this.#materialize(capability, { request, state, domainIdentity });
      entry.hitCount = 1;
      entry.lastUsedRun = this.runNumber;
      runtimeById.set(capability.id, entry.instance);
      entriesById.set(capability.id, entry);
      materializedCapabilityIds.push(capability.id);
      newlyMaterializedBytes += entry.allocatedBytes;
      closureBodyBytes += entry.allocatedBytes;
      materializationReceipts.push({
        capabilityId: capability.id,
        allocatedBytes: entry.allocatedBytes,
        materializeMs: entry.materializeMs,
        sourceDomains: entry.sourceDomains,
        bodyIdentityHash: entry.bodyIdentityHash,
      });
    }

    const outputs = {};
    const executionReceipts = [];
    const executeStarted = performance.now();
    for (const capability of ordered) {
      const started = performance.now();
      const dependencies = Object.fromEntries(
        (capability.dependencies || [])
          .filter((depId) => depId in outputs)
          .map((depId) => [depId, outputs[depId]])
      );
      const output = await capability.run(Object.freeze({
        request,
        state,
        dependencies,
        runtime: runtimeById.get(capability.id) ?? null,
      }));
      outputs[capability.id] = output;
      executionReceipts.push({
        capabilityId: capability.id,
        dependencies: [...(capability.dependencies || [])],
        outputHash: hashValue(output),
        elapsedMs: performance.now() - started,
      });
    }
    const executeMs = performance.now() - executeStarted;

    const budgetEvictions = [];
    const transientCapabilityIds = [];
    const retainedNewCapabilityIds = [];

    for (const capability of ordered) {
      if (!materializedCapabilityIds.includes(capability.id)) continue;
      const entry = entriesById.get(capability.id);
      if (this.policy === "none" || entry.allocatedBytes > this.maxCacheBytes) {
        transientCapabilityIds.push(capability.id);
        continue;
      }
      this.cache.set(capability.id, entry);
      const evicted = await this.#evictToBudget({ request, state });
      budgetEvictions.push(...evicted);
      if (this.cache.has(capability.id)) retainedNewCapabilityIds.push(capability.id);
      else transientCapabilityIds.push(capability.id);
    }

    for (const capabilityId of materializedCapabilityIds) {
      const entry = entriesById.get(capabilityId);
      if (!this.cache.has(capabilityId) && !entry.released) {
        const releaseReceipt = await this.#releaseRuntime(
          capabilityId,
          entry,
          { request, state },
          "transient-after-workset"
        );
        if (releaseReceipt) this.evictionHistory.push(releaseReceipt);
      }
    }

    if (this.cacheBytes > this.maxCacheBytes) throw new Error("hard retained cache budget invariant violated");

    const result = Object.fromEntries(Object.keys(outputs).sort().map((id) => [id, outputs[id]]));
    return {
      result,
      receipt: {
        schema: "axm.ignition-budgeted-workset-run/v0.11",
        policy: this.policy,
        runNumber: this.runNumber,
        requestHash: hashValue(request),
        stateHash,
        domainIdentityHash: domainIdentity?.identityHash || null,
        matchedCapabilityIds: matched.map((capability) => capability.id),
        closureCapabilityIds: closure.map((capability) => capability.id),
        executionOrder: ordered.map((capability) => capability.id),
        cacheHitCapabilityIds,
        cacheMissCapabilityIds: materializedCapabilityIds,
        cacheHitCount: cacheHitCapabilityIds.length,
        cacheMissCount: materializedCapabilityIds.length,
        newlyMaterializedBytes,
        closureBodyBytes,
        materializationReceipts,
        executionReceipts,
        executeMs,
        retainedNewCapabilityIds: [...new Set(retainedNewCapabilityIds)].sort(),
        transientCapabilityIds: [...new Set(transientCapabilityIds)].sort(),
        budgetEvictions,
        invalidatedForStateChange,
        invalidatedForDomainIdentity,
        cacheBytesAfter: this.cacheBytes,
        cacheCapabilityIds: this.cachedCapabilityIds,
        resultHash: hashValue(result),
        retainedBudgetBytes: this.maxCacheBytes,
        budgetMeaning: "Hard ceiling applies to retained cache. A required closure may temporarily materialize more bytes during one run.",
      },
    };
  }
}
