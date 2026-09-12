import { performance } from "node:perf_hooks";

import { BudgetedWorksetSession } from "../src/workset-session.js";
import { hashValue } from "../src/ignition-core.js";
import { runDirectRealisticBaseline } from "../src/direct-realistic-baseline.js";
import {
  REALISTIC_DOMAIN_BINDINGS,
  changeWorkspaceImportTarget,
} from "../src/realistic-mutations.js";
import {
  applyWorkspacePointMutation,
  buildWorkspaceDomainEntryIndex,
  createWorkspacePointMutationReceipt,
} from "../src/incremental-domain-index.js";
import { buildRealisticRegistry, buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";

const mode = process.argv[2] || "workset";
const scenario = process.argv[3] || "partial";
const fileCount = Number(process.argv[4] || 2500);
if (!["direct", "workset"].includes(mode)) throw new Error("mode must be direct or workset");
if (!["partial", "mutation", "tight", "none"].includes(scenario)) throw new Error("unknown workset scenario");

function sum(rows, key) {
  return rows.reduce((total, row) => total + Number(row?.[key] || 0), 0);
}

async function buildExpected(state, stateHash) {
  return runDirectRealisticBaseline({
    request: realisticRequests.report,
    state,
    registry: buildRealisticRegistry(),
    stateFingerprint: stateHash,
  });
}

const before = buildWorkspaceState({ fileCount });
let stateHashBuildMs = 0;
const hashStarted = performance.now();
const beforeHash = hashValue(before);
stateHashBuildMs += performance.now() - hashStarted;

let targetState = before;
let targetHash = beforeHash;
let after = null;
if (scenario === "mutation") {
  after = changeWorkspaceImportTarget(before, 12, 13, 14);
  const afterHashStarted = performance.now();
  targetHash = hashValue(after);
  stateHashBuildMs += performance.now() - afterHashStarted;
  targetState = after;
}

const expected = await buildExpected(targetState, targetHash);
const expectedHash = expected.receipt.resultHash;

let identityBuildMs = 0;
let primeWallMs = 0;
let mutationReceiptBuildMs = 0;
let identityAdvanceMs = 0;
let reportWallMs = 0;
let totalMaterializedBytes = 0;
let reportMaterializedBytes = 0;
let reportCacheHits = 0;
let reportCacheMisses = 0;
let reportInvalidatedCapabilityIds = [];
let budgetEvictionCount = 0;
let transientCount = 0;
let cacheBytesAfter = 0;
let finalCacheCapabilityIds = [];
let equivalent = true;
let reportRuns = scenario === "tight" ? 3 : 1;
let executionOrder = [];
let closureBodyBytes = 0;
let incrementalFilesInspected = 0;
let incrementalDomainsRehashed = 0;

if (mode === "direct") {
  const started = performance.now();
  for (let i = 0; i < reportRuns; i += 1) {
    const run = await runDirectRealisticBaseline({
      request: realisticRequests.report,
      state: targetState,
      registry: buildRealisticRegistry(),
      stateFingerprint: targetHash,
    });
    equivalent &&= run.receipt.resultHash === expectedHash;
    totalMaterializedBytes += run.receipt.actualMaterializedBytes;
    reportMaterializedBytes += run.receipt.actualMaterializedBytes;
    executionOrder = [...run.receipt.route];
  }
  reportWallMs = performance.now() - started;
} else {
  let index;
  if (scenario !== "none") {
    const identityStarted = performance.now();
    index = buildWorkspaceDomainEntryIndex(before, null, { stateHash: beforeHash });
    identityBuildMs = performance.now() - identityStarted;
  }

  const maxCacheBytes = scenario === "tight" ? 900_000 : scenario === "none" ? 0 : 2_000_000;
  const policy = scenario === "none" ? "none" : "lru";
  const session = new BudgetedWorksetSession({
    registry: buildRealisticRegistry(),
    maxCacheBytes,
    policy,
    domainBindings: REALISTIC_DOMAIN_BINDINGS,
  });

  try {
    if (scenario === "partial" || scenario === "mutation") {
      const primeStarted = performance.now();
      const primeSearch = await session.run({
        request: realisticRequests.search,
        state: before,
        domainIdentity: index.identity,
      });
      const primeDependencies = await session.run({
        request: realisticRequests.dependencies,
        state: before,
        domainIdentity: index.identity,
      });
      primeWallMs = performance.now() - primeStarted;
      totalMaterializedBytes += primeSearch.receipt.newlyMaterializedBytes + primeDependencies.receipt.newlyMaterializedBytes;
    }

    if (scenario === "mutation") {
      const receiptStarted = performance.now();
      const mutationReceipt = createWorkspacePointMutationReceipt({
        beforeState: before,
        afterState: after,
        fileIndex: 12,
        fromStateHash: beforeHash,
        toStateHash: targetHash,
      });
      mutationReceiptBuildMs = performance.now() - receiptStarted;

      const advanceStarted = performance.now();
      index = applyWorkspacePointMutation({ index, mutationReceipt, nextState: after });
      identityAdvanceMs = performance.now() - advanceStarted;
      incrementalFilesInspected = index.lastAdvance.filesInspected;
      incrementalDomainsRehashed = index.lastAdvance.domainsRehashed.length;
    }

    const timedStarted = performance.now();
    for (let i = 0; i < reportRuns; i += 1) {
      const run = await session.run({
        request: realisticRequests.report,
        state: targetState,
        stateFingerprint: targetHash,
        domainIdentity: scenario === "none" ? null : index.identity,
      });
      equivalent &&= run.receipt.resultHash === expectedHash;
      totalMaterializedBytes += run.receipt.newlyMaterializedBytes;
      reportMaterializedBytes += run.receipt.newlyMaterializedBytes;
      reportCacheHits += run.receipt.cacheHitCount;
      reportCacheMisses += run.receipt.cacheMissCount;
      reportInvalidatedCapabilityIds.push(...run.receipt.invalidatedForDomainIdentity.map((entry) => entry.capabilityId));
      budgetEvictionCount += run.receipt.budgetEvictions.length;
      transientCount += run.receipt.transientCapabilityIds.length;
      cacheBytesAfter = run.receipt.cacheBytesAfter;
      finalCacheCapabilityIds = [...run.receipt.cacheCapabilityIds];
      executionOrder = [...run.receipt.executionOrder];
      closureBodyBytes = run.receipt.closureBodyBytes;
    }
    reportWallMs = performance.now() - timedStarted;
  } finally {
    await session.close({ state: targetState });
  }
}

const identitySpecificMs = identityBuildMs + mutationReceiptBuildMs + identityAdvanceMs;
const chargedLifecycleMs = stateHashBuildMs + identitySpecificMs + primeWallMs + reportWallMs;

console.log(JSON.stringify({
  schema: "axm.ignition-workset-probe/v0.11",
  mode,
  scenario,
  fileCount,
  reportRuns,
  equivalent,
  stateHashBuildMs,
  identityBuildMs,
  primeWallMs,
  mutationReceiptBuildMs,
  identityAdvanceMs,
  identitySpecificMs,
  reportWallMs,
  chargedLifecycleMs,
  totalMaterializedBytes,
  reportMaterializedBytes,
  reportCacheHits,
  reportCacheMisses,
  reportInvalidatedCapabilityIds: [...new Set(reportInvalidatedCapabilityIds)].sort(),
  budgetEvictionCount,
  transientCount,
  cacheBytesAfter,
  finalCacheCapabilityIds,
  executionOrder,
  closureBodyBytes,
  incrementalFilesInspected,
  incrementalDomainsRehashed,
  retainedBudgetBytes: scenario === "tight" ? 900_000 : scenario === "none" ? 0 : 2_000_000,
  truthBoundary: "Hard budget applies to retained cache; required closure bodies may be transiently materialized for execution.",
  timingBoundary: "Direct reference verification is excluded. Charged lifecycle includes state fingerprint cost, identity bootstrap/update where used, explicit priming where used, and timed report execution.",
}));
