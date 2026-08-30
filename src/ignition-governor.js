import { CapabilityRegistry, executeIgnitionRun, hashValue } from "./ignition-core.js";
import { IgnitionSession } from "./ignition-session.js";

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

function updateTiming(stats, mode, elapsedMs) {
  const current = stats.get(mode) || { count: 0, totalMs: 0, averageMs: 0 };
  current.count += 1; current.totalMs += elapsedMs; current.averageMs = current.totalMs / current.count; stats.set(mode, current);
}

export class IgnitionGovernor {
  constructor({ registry, directRunner = null, cacheBudgetBytes = Number.POSITIVE_INFINITY, eagerBreadthThreshold = 0.8, directMaxCapabilities = 1, stateChurnMinRuns = 2, stateChurnThreshold = 0.5 }) {
    if (!(registry instanceof CapabilityRegistry)) throw new Error("registry must be CapabilityRegistry");
    if (directRunner && typeof directRunner !== "function") throw new Error("directRunner must be a function");
    if (!(cacheBudgetBytes >= 0)) throw new Error("cacheBudgetBytes must be >= 0");
    this.registry = registry; this.directRunner = directRunner; this.cacheBudgetBytes = cacheBudgetBytes;
    this.eagerBreadthThreshold = eagerBreadthThreshold; this.directMaxCapabilities = directMaxCapabilities;
    this.stateChurnMinRuns = stateChurnMinRuns; this.stateChurnThreshold = stateChurnThreshold;
    this.capabilityBytes = new Map(); this.routeSeen = new Map(); this.modeTiming = new Map();
    this.session = null; this.sessionMode = null; this.lastStateHash = null; this.stateChangeCount = 0; this.runCount = 0; this.decisions = [];
  }

  async close(context = {}) { if (this.session) await this.session.close(context); this.session = null; this.sessionMode = null; }

  #route(request, state) {
    const matched = this.registry.matched(request, state), closure = dependencyClosure(this.registry, matched);
    const ids = closure.map((capability) => capability.id);
    return { matched, closure, ids, signature: ids.join("|"), breadth: this.registry.all().length ? closure.length / this.registry.all().length : 0 };
  }
  #predictedBytes(ids) { let total = 0; for (const id of ids) { if (!this.capabilityBytes.has(id)) return null; total += this.capabilityBytes.get(id); } return total; }
  #stateChangeRate() { return this.runCount === 0 ? 0 : this.stateChangeCount / this.runCount; }
  #sessionCanServe(route, stateHash) { if (!this.session || this.session.stateHash !== stateHash) return false; if (this.sessionMode === "eager") return true; return route.ids.every((id) => this.session.cache.has(id)); }
  #additionalCacheBytes(route) { if (!this.session) return this.#predictedBytes(route.ids); let total = 0; for (const id of route.ids) { if (this.session.cache.has(id)) continue; if (!this.capabilityBytes.has(id)) return null; total += this.capabilityBytes.get(id); } return total; }

  #choose({ route, stateHash }) {
    const seen = this.routeSeen.get(route.signature) || 0;
    const stateChangeRate = this.#stateChangeRate();
    const churnHigh = this.runCount >= this.stateChurnMinRuns && stateChangeRate >= this.stateChurnThreshold;
    if (this.#sessionCanServe(route, stateHash)) return { mode: this.sessionMode === "eager" ? "eager-warm" : "ignition-warm", reason: "warm-cache-hit", seen, stateChangeRate };
    if (churnHigh) return { mode: this.directRunner && route.ids.length <= this.directMaxCapabilities ? "direct-cold" : "ignition-cold", reason: "state-churn-avoids-retention", seen, stateChangeRate };

    const routeBytes = this.#predictedBytes(route.ids), additionalBytes = this.#additionalCacheBytes(route), currentCacheBytes = this.session?.cacheBytes || 0;
    const warmFits = additionalBytes !== null && currentCacheBytes + additionalBytes <= this.cacheBudgetBytes;
    if (this.session && this.sessionMode === "ignition" && seen > 0 && warmFits) return { mode: "ignition-warm", reason: "expand-existing-warm-cache", seen, stateChangeRate };

    const fullIds = this.registry.all().map((capability) => capability.id), fullBytes = this.#predictedBytes(fullIds);
    if (seen > 0 && route.breadth >= this.eagerBreadthThreshold && fullBytes !== null && fullBytes <= this.cacheBudgetBytes) return { mode: "eager-warm", reason: "broad-reused-route-fits-cache", seen, stateChangeRate };
    if (seen > 0 && routeBytes !== null && routeBytes <= this.cacheBudgetBytes) return { mode: "ignition-warm", reason: "reused-route-fits-cache", seen, stateChangeRate };
    if (this.directRunner && route.ids.length <= this.directMaxCapabilities) return { mode: "direct-cold", reason: routeBytes !== null && routeBytes > this.cacheBudgetBytes ? "route-exceeds-cache-budget" : "first-narrow-route-direct", seen, stateChangeRate };
    return { mode: "ignition-cold", reason: routeBytes !== null && routeBytes > this.cacheBudgetBytes ? "route-exceeds-cache-budget" : "measure-before-retaining", seen, stateChangeRate };
  }

  async #ensureSession(mode, context) {
    const wanted = mode === "eager-warm" ? "eager" : "ignition";
    if (this.session && this.sessionMode === wanted) return this.session;
    if (this.session) await this.session.close(context);
    this.session = new IgnitionSession({ registry: this.registry, mode: wanted }); this.sessionMode = wanted; return this.session;
  }

  #learnCapabilityBytes(receipts) {
    for (const receipt of receipts || []) {
      if (!receipt?.capabilityId) continue;
      const bytes = Number(receipt.allocatedBytes);
      if (Number.isSafeInteger(bytes) && bytes >= 0) this.capabilityBytes.set(receipt.capabilityId, bytes);
    }
  }

  async run({ request, state = {} }) {
    const stateHash = hashValue(state);
    if (this.lastStateHash !== null && this.lastStateHash !== stateHash) { this.stateChangeCount += 1; if (this.session) await this.close({ request, state }); }
    this.lastStateHash = stateHash;
    const route = this.#route(request, state), decision = this.#choose({ route, stateHash });
    const started = performance.now();
    let outcome;

    if (decision.mode === "direct-cold") {
      outcome = await this.directRunner({ request, state, registry: this.registry, stateFingerprint: stateHash });
      if (route.ids.length === 1) this.capabilityBytes.set(route.ids[0], outcome.receipt.actualMaterializedBytes);
    } else if (decision.mode === "ignition-cold") {
      outcome = await executeIgnitionRun({ registry: this.registry, request, state, mode: "ignition", stateFingerprint: stateHash });
      this.#learnCapabilityBytes(outcome.receipt.materializationReceipts);
    } else {
      const session = await this.#ensureSession(decision.mode, { request, state });
      outcome = await session.run({ request, state, stateFingerprint: stateHash });
      this.#learnCapabilityBytes(outcome.receipt.newMaterializationReceipts);
    }

    const elapsedMs = performance.now() - started;
    updateTiming(this.modeTiming, decision.mode, elapsedMs);
    this.routeSeen.set(route.signature, (this.routeSeen.get(route.signature) || 0) + 1); this.runCount += 1;
    const receipt = {
      schema: "axm.ignition-governor-decision/v0.05", runNumber: this.runCount, selectedMode: decision.mode, reason: decision.reason,
      routeCapabilityIds: route.ids, routeBreadth: route.breadth, predictedRouteBytes: this.#predictedBytes(route.ids), cacheBudgetBytes: this.cacheBudgetBytes,
      retainedCacheBytes: this.session?.cacheBytes || 0, retainedCacheCapabilityIds: this.session?.cachedCapabilityIds || [], stateChangeRate: this.#stateChangeRate(),
      canonicalFingerprintShared: outcome.receipt.stateFingerprintReused === true, resultHash: outcome.receipt.resultHash, elapsedMs,
      modeTiming: Object.fromEntries([...this.modeTiming.entries()].map(([mode, stats]) => [mode, { ...stats }]))
    };
    this.decisions.push(receipt);
    return { result: outcome.result, receipt, executionReceipt: outcome.receipt };
  }
}
