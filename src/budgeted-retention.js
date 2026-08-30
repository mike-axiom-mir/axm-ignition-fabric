import { CapabilityRegistry, hashValue } from "./ignition-core.js";
import { bodyIdentity, validateDomainIdentity } from "./domain-identity.js";
import { validateTransitionReceipt } from "./scoped-invalidation.js";

function deterministicCandidateOrder(entries, policy) {
  return [...entries].sort((a, b) => {
    if (policy === "lru") return a[1].lastUsedRun - b[1].lastUsedRun || a[0].localeCompare(b[0]);
    if (policy === "value") {
      const aUnits = Math.max(1, a[1].allocatedBytes / 65536);
      const bUnits = Math.max(1, b[1].allocatedBytes / 65536);
      const aScore = (a[1].materializeMs * (a[1].hitCount + 1)) / aUnits;
      const bScore = (b[1].materializeMs * (b[1].hitCount + 1)) / bUnits;
      return aScore - bScore || a[1].lastUsedRun - b[1].lastUsedRun || a[0].localeCompare(b[0]);
    }
    throw new Error(`unknown retention policy: ${policy}`);
  });
}

function normalizeDomainBindings(bindings) {
  const out = new Map();
  for (const [capabilityId, domains] of Object.entries(bindings || {})) {
    out.set(capabilityId, [...new Set(domains || [])].sort());
  }
  return out;
}

export class BudgetedRetentionSession {
  constructor({ registry, maxCacheBytes, policy = "value", invalidationResolver = null, domainBindings = null }) {
    if (!(registry instanceof CapabilityRegistry)) throw new Error("registry must be CapabilityRegistry");
    if (!Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 0) throw new Error("maxCacheBytes must be a non-negative safe integer");
    if (!["none", "lru", "value"].includes(policy)) throw new Error("policy must be none, lru, or value");
    if (invalidationResolver !== null && typeof invalidationResolver !== "function") throw new Error("invalidationResolver must be a function or null");
    this.registry = registry;
    this.maxCacheBytes = maxCacheBytes;
    this.policy = policy;
    this.invalidationResolver = invalidationResolver;
    this.domainBindings = normalizeDomainBindings(domainBindings);
    this.cache = new Map();
    this.stateHash = null;
    this.domainIdentity = null;
    this.runNumber = 0;
    this.closed = false;
    this.evictionHistory = [];
    this.transitionHistory = [];
  }

  get cacheBytes() { let total = 0; for (const entry of this.cache.values()) total += entry.allocatedBytes; return total; }
  get cachedCapabilityIds() { return [...this.cache.keys()].sort(); }

  async #releaseEntry(id, context, reason) {
    const entry = this.cache.get(id);
    if (!entry) return null;
    const capability = this.registry.get(id);
    if (capability?.release) {
      await capability.release(Object.freeze({
        request: context.request ?? null,
        state: context.state ?? null,
        mode: `budgeted-${this.policy}`,
        runtime: entry.instance,
      }));
    }
    this.cache.delete(id);
    const receipt = {
      capabilityId: id,
      allocatedBytes: entry.allocatedBytes,
      hitCount: entry.hitCount,
      materializeMs: entry.materializeMs,
      lastUsedRun: entry.lastUsedRun,
      sourceDomains: entry.sourceDomains || null,
      bodyIdentityHash: entry.bodyIdentityHash || null,
      reason,
    };
    this.evictionHistory.push(receipt);
    return receipt;
  }

  async #releaseIds(ids, context = {}, reason = "release-ids") {
    const receipts = [];
    for (const id of [...new Set(ids || [])].sort()) {
      const receipt = await this.#releaseEntry(id, context, reason);
      if (receipt) receipts.push(receipt);
    }
    return receipts;
  }

  async releaseAll(context = {}, reason = "release-all") {
    const receipts = await this.#releaseIds(this.cachedCapabilityIds, context, reason);
    this.stateHash = null;
    this.domainIdentity = null;
    return receipts;
  }

  async close(context = {}) {
    if (this.closed) return;
    await this.releaseAll(context, "session-close");
    this.closed = true;
  }

  async applyTransition({ transitionReceipt, state = null, invalidationResolver = this.invalidationResolver, nextDomainIdentity = null }) {
    if (this.closed) throw new Error("BudgetedRetentionSession is closed");
    if (this.stateHash === null) throw new Error("cannot apply transition before session has a canonical state");
    if (typeof invalidationResolver !== "function") throw new Error("trusted transition requires an invalidationResolver");
    validateTransitionReceipt(transitionReceipt, { expectedFrom: this.stateHash });
    if (nextDomainIdentity) {
      validateDomainIdentity(nextDomainIdentity);
      if (nextDomainIdentity.stateHash !== transitionReceipt.toStateHash) throw new Error("next domain identity does not bind transition target");
    }

    const resolution = invalidationResolver({ transitionReceipt, cachedCapabilityIds: this.cachedCapabilityIds });
    const invalidatedCapabilityIds = [...new Set(resolution?.invalidatedCapabilityIds || [])].sort();
    const staleReleases = await this.#releaseIds(invalidatedCapabilityIds, { state }, "transition-stale");
    this.stateHash = transitionReceipt.toStateHash;
    this.domainIdentity = nextDomainIdentity || null;

    const receipt = {
      schema: "axm.ignition-budget-transition/v0.09",
      transitionReceiptHash: transitionReceipt.receiptHash,
      changedDomains: [...transitionReceipt.changedDomains],
      invalidatedCapabilityIds,
      releasedCapabilityIds: staleReleases.map((entry) => entry.capabilityId).sort(),
      releasedBytes: staleReleases.reduce((sum, entry) => sum + entry.allocatedBytes, 0),
      retainedValidCapabilityIds: this.cachedCapabilityIds,
      retainedValidBytes: this.cacheBytes,
      cacheBudgetBytes: this.maxCacheBytes,
      resultingStateHash: this.stateHash,
      resultingDomainIdentityHash: this.domainIdentity?.identityHash || null,
    };
    this.transitionHistory.push(receipt);
    return receipt;
  }

  async #reconcileDomainIdentity(nextIdentity, context) {
    validateDomainIdentity(nextIdentity);
    const released = [];

    if (this.domainIdentity === null) {
      if (this.cache.size) released.push(...await this.#releaseIds(this.cachedCapabilityIds, context, "domain-identity-adoption"));
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
        const receipt = await this.#releaseEntry(id, context, "domain-identity-unbound");
        if (receipt) released.push(receipt);
        continue;
      }
      let currentBodyIdentity;
      try {
        currentBodyIdentity = bodyIdentity({ capabilityId: id, identity: nextIdentity, domains: entry.sourceDomains });
      } catch {
        currentBodyIdentity = null;
      }
      if (!currentBodyIdentity || currentBodyIdentity.bodyIdentityHash !== entry.bodyIdentityHash) {
        const receipt = await this.#releaseEntry(id, context, "domain-identity-change");
        if (receipt) released.push(receipt);
      }
    }

    this.domainIdentity = nextIdentity;
    this.stateHash = nextIdentity.stateHash;
    return released;
  }

  async #evictForBytes(requiredBytes, protectedId, context) {
    const evicted = [];
    if (this.policy === "none") return evicted;
    while (this.cacheBytes + requiredBytes > this.maxCacheBytes) {
      const candidates = deterministicCandidateOrder([...this.cache.entries()].filter(([id]) => id !== protectedId), this.policy);
      if (!candidates.length) break;
      const receipt = await this.#releaseEntry(candidates[0][0], context, "budget");
      if (receipt) evicted.push(receipt);
    }
    return evicted;
  }

  async run({ request, state = {}, stateFingerprint = null, domainIdentity = null }) {
    if (this.closed) throw new Error("BudgetedRetentionSession is closed");
    if (stateFingerprint !== null && typeof stateFingerprint !== "string") throw new Error("stateFingerprint must be a string or null");
    if (domainIdentity) {
      validateDomainIdentity(domainIdentity);
      if (stateFingerprint !== null && stateFingerprint !== domainIdentity.stateHash) throw new Error("stateFingerprint does not match domain identity stateHash");
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
    if (matched.length !== 1 || (matched[0].dependencies || []).length !== 0) {
      throw new Error("v0.09 budgeted retention supports exactly one dependency-free matched capability per request");
    }
    const capability = matched[0];
    const cached = this.cache.get(capability.id);
    let entry = cached;
    const cacheHit = Boolean(cached);
    let materializedBytes = 0;
    let materializeMs = 0;
    let retained = true;
    let evicted = [];

    if (!entry) {
      const started = performance.now();
      const body = capability.materialize
        ? await capability.materialize(Object.freeze({ request, state, mode: `budgeted-${this.policy}` }))
        : { instance: null, allocatedBytes: 0 };
      materializeMs = performance.now() - started;
      const allocatedBytes = Number(body?.allocatedBytes ?? 0);
      if (!Number.isSafeInteger(allocatedBytes) || allocatedBytes < 0) throw new Error(`invalid allocatedBytes from ${capability.id}`);
      materializedBytes = allocatedBytes;
      const sourceDomains = this.domainBindings.get(capability.id) || null;
      const identityReceipt = domainIdentity && sourceDomains?.length
        ? bodyIdentity({ capabilityId: capability.id, identity: domainIdentity, domains: sourceDomains })
        : null;
      entry = {
        instance: body?.instance ?? null,
        allocatedBytes,
        materializeMs,
        hitCount: 0,
        lastUsedRun: this.runNumber,
        sourceDomains,
        bodyIdentityHash: identityReceipt?.bodyIdentityHash || null,
        validityKey: identityReceipt?.validityKey || null,
      };

      if (this.policy === "none" || allocatedBytes > this.maxCacheBytes) {
        retained = false;
      } else {
        evicted = await this.#evictForBytes(allocatedBytes, capability.id, { request, state });
        if (this.cacheBytes + allocatedBytes <= this.maxCacheBytes) this.cache.set(capability.id, entry);
        else retained = false;
      }
    }

    entry.hitCount += 1;
    entry.lastUsedRun = this.runNumber;
    const executeStarted = performance.now();
    const output = await capability.run(Object.freeze({ request, state, dependencies: {}, runtime: entry.instance }));
    const executeMs = performance.now() - executeStarted;

    if (!retained) {
      if (capability.release) await capability.release(Object.freeze({ request, state, mode: `budgeted-${this.policy}`, runtime: entry.instance }));
    } else if (this.cache.has(capability.id)) {
      this.cache.set(capability.id, entry);
    }

    if (this.cacheBytes > this.maxCacheBytes) throw new Error("hard cache budget invariant violated");
    const result = { [capability.id]: output };
    return {
      result,
      receipt: {
        schema: "axm.ignition-budgeted-retention-run/v0.09",
        policy: this.policy,
        runNumber: this.runNumber,
        capabilityId: capability.id,
        cacheHit,
        retained,
        materializedBytes,
        materializeMs,
        executeMs,
        evicted,
        invalidatedForStateChange,
        invalidatedForDomainIdentity,
        cacheBytesAfter: this.cacheBytes,
        cacheCapabilityIds: this.cachedCapabilityIds,
        resultHash: hashValue(result),
        stateHash,
        domainIdentityHash: domainIdentity?.identityHash || null,
        sourceDomains: entry.sourceDomains || null,
        bodyIdentityHash: entry.bodyIdentityHash || null,
        validityKey: entry.validityKey || null,
      },
    };
  }
}
