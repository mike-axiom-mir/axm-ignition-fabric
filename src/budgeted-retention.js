import { CapabilityRegistry, hashValue } from "./ignition-core.js";

function deterministicCandidateOrder(entries, policy) {
  return [...entries].sort((a, b) => {
    if (policy === "lru") {
      return a[1].lastUsedRun - b[1].lastUsedRun || a[0].localeCompare(b[0]);
    }
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

export class BudgetedRetentionSession {
  constructor({ registry, maxCacheBytes, policy = "value" }) {
    if (!(registry instanceof CapabilityRegistry)) throw new Error("registry must be CapabilityRegistry");
    if (!Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 0) throw new Error("maxCacheBytes must be a non-negative safe integer");
    if (!["none", "lru", "value"].includes(policy)) throw new Error("policy must be none, lru, or value");
    this.registry = registry;
    this.maxCacheBytes = maxCacheBytes;
    this.policy = policy;
    this.cache = new Map();
    this.stateHash = null;
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
      reason,
    };
    this.evictionHistory.push(receipt);
    return receipt;
  }

  async releaseAll(context = {}, reason = "release-all") {
    const receipts = [];
    for (const id of this.cachedCapabilityIds) {
      const receipt = await this.#releaseEntry(id, context, reason);
      if (receipt) receipts.push(receipt);
    }
    this.stateHash = null;
    return receipts;
  }

  async close(context = {}) {
    if (this.closed) return;
    await this.releaseAll(context, "session-close");
    this.closed = true;
  }

  async #evictForBytes(requiredBytes, protectedId, context) {
    const evicted = [];
    if (this.policy === "none") return evicted;
    while (this.cacheBytes + requiredBytes > this.maxCacheBytes) {
      const candidates = deterministicCandidateOrder(
        [...this.cache.entries()].filter(([id]) => id !== protectedId),
        this.policy
      );
      if (!candidates.length) break;
      const receipt = await this.#releaseEntry(candidates[0][0], context, "budget");
      if (receipt) evicted.push(receipt);
    }
    return evicted;
  }

  async run({ request, state = {}, stateFingerprint = null }) {
    if (this.closed) throw new Error("BudgetedRetentionSession is closed");
    const stateHash = stateFingerprint ?? hashValue(state);
    let invalidatedForStateChange = [];
    if (this.stateHash !== null && this.stateHash !== stateHash) {
      invalidatedForStateChange = await this.releaseAll({ request, state }, "state-change");
    }
    this.stateHash = stateHash;
    this.runNumber += 1;

    const matched = this.registry.matched(request, state);
    if (matched.length !== 1 || (matched[0].dependencies || []).length !== 0) {
      throw new Error("v0.07 budgeted retention supports exactly one dependency-free matched capability per request");
    }
    const capability = matched[0];
    const cached = this.cache.get(capability.id);
    let entry = cached;
    let cacheHit = Boolean(cached);
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
      entry = {
        instance: body?.instance ?? null,
        allocatedBytes,
        materializeMs,
        hitCount: 0,
        lastUsedRun: this.runNumber,
      };

      if (this.policy === "none" || allocatedBytes > this.maxCacheBytes) {
        retained = false;
      } else {
        evicted = await this.#evictForBytes(allocatedBytes, capability.id, { request, state });
        if (this.cacheBytes + allocatedBytes <= this.maxCacheBytes) {
          this.cache.set(capability.id, entry);
        } else {
          retained = false;
        }
      }
    }

    entry.hitCount += 1;
    entry.lastUsedRun = this.runNumber;
    const executeStarted = performance.now();
    const output = await capability.run(Object.freeze({ request, state, dependencies: {}, runtime: entry.instance }));
    const executeMs = performance.now() - executeStarted;

    if (!retained) {
      if (capability.release) {
        await capability.release(Object.freeze({ request, state, mode: `budgeted-${this.policy}`, runtime: entry.instance }));
      }
    } else if (this.cache.has(capability.id)) {
      this.cache.set(capability.id, entry);
    }

    const result = { [capability.id]: output };
    return {
      result,
      receipt: {
        schema: "axm.ignition-budgeted-retention-run/v0.07",
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
        cacheBytesAfter: this.cacheBytes,
        cacheCapabilityIds: this.cachedCapabilityIds,
        resultHash: hashValue(result),
        stateHash,
      },
    };
  }
}
