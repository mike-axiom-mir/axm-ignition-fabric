import { BudgetedRetentionSession } from "../src/budgeted-retention.js";
import { createVersionedDomainIdentity } from "../src/domain-identity.js";
import { hashValue } from "../src/ignition-core.js";
import {
  applyWorkspacePointMutation,
  buildWorkspaceDomainEntryIndex,
  createWorkspacePointMutationReceipt,
} from "../src/incremental-domain-index.js";
import { runDirectRealisticBaseline } from "../src/direct-realistic-baseline.js";
import {
  REALISTIC_DOMAIN_BINDINGS,
  changeWorkspaceImportTarget,
  changeWorkspacePath,
  workspaceDomainHashes,
} from "../src/realistic-mutations.js";
import { buildRealisticRegistry, buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";

const mode = process.argv[2] || "incremental";
const scenario = process.argv[3] || "path";
const transitionCount = Number(process.argv[4] || 6);
const fileCount = Number(process.argv[5] || 2500);
if (!["full-state", "full-domain", "incremental"].includes(mode)) throw new Error("mode must be full-state, full-domain, or incremental");
if (!["path", "import"].includes(scenario)) throw new Error("scenario must be path or import");

function buildStates() {
  const states = [buildWorkspaceState({ fileCount })];
  for (let i = 0; i < transitionCount; i += 1) {
    const current = states.at(-1);
    if (scenario === "path") {
      states.push(changeWorkspacePath(current, 17, `.inc${i + 1}`));
    } else {
      const fileId = 12;
      const originalTarget = (fileId + 1) % fileCount;
      const previous = i === 0 ? originalTarget : (originalTarget + i) % fileCount;
      const target = (originalTarget + i + 1) % fileCount;
      states.push(changeWorkspaceImportTarget(current, fileId, previous, target));
    }
  }
  return states;
}

const states = buildStates();
const requests = scenario === "path"
  ? [realisticRequests.search, { kind: "metadata" }]
  : [realisticRequests.search, realisticRequests.dependencies];
const mutationFileIndex = scenario === "path" ? 17 : 12;

const stateFingerprintStarted = performance.now();
const stateHashes = states.map((state) => hashValue(state));
const stateFingerprintBuildMs = performance.now() - stateFingerprintStarted;

let identities = null;
let fullDomainBuildMs = 0;
let incrementalBootstrapMs = 0;
let mutationReceiptBuildMs = 0;
let incrementalUpdateMs = 0;
let referenceVerificationMs = 0;
let incrementalMetrics = null;

// Build the full-scan reference using the same precomputed canonical state hashes.
const referenceStarted = performance.now();
const referenceIdentities = [];
let previousReference = null;
for (let i = 0; i < states.length; i += 1) {
  const domainHashes = workspaceDomainHashes(states[i]);
  previousReference = createVersionedDomainIdentity({
    stateHash: stateHashes[i],
    domainHashes,
    previousIdentity: previousReference,
  });
  referenceIdentities.push(previousReference);
}
const referenceBuildMs = performance.now() - referenceStarted;

if (mode === "full-domain") {
  identities = referenceIdentities;
  fullDomainBuildMs = referenceBuildMs;
} else if (mode === "incremental") {
  const bootstrapStarted = performance.now();
  let index = buildWorkspaceDomainEntryIndex(states[0], null, { stateHash: stateHashes[0] });
  incrementalBootstrapMs = performance.now() - bootstrapStarted;
  identities = [index.identity];
  let totalFilesInspected = index.lastAdvance.filesInspected;
  let totalDomainsRehashed = index.lastAdvance.domainsRehashed.length;

  for (let i = 1; i < states.length; i += 1) {
    const receiptStarted = performance.now();
    const receipt = createWorkspacePointMutationReceipt({
      beforeState: states[i - 1],
      afterState: states[i],
      fileIndex: mutationFileIndex,
      fromStateHash: stateHashes[i - 1],
      toStateHash: stateHashes[i],
      evidence: { scenario, transition: i },
    });
    mutationReceiptBuildMs += performance.now() - receiptStarted;

    const updateStarted = performance.now();
    index = applyWorkspacePointMutation({ index, mutationReceipt: receipt, nextState: states[i] });
    incrementalUpdateMs += performance.now() - updateStarted;
    totalFilesInspected += index.lastAdvance.filesInspected;
    totalDomainsRehashed += index.lastAdvance.domainsRehashed.length;
    identities.push(index.identity);
  }

  const verifyStarted = performance.now();
  for (let i = 0; i < identities.length; i += 1) {
    if (JSON.stringify(identities[i]) !== JSON.stringify(referenceIdentities[i])) {
      throw new Error(`incremental identity mismatch at state ${i}`);
    }
  }
  referenceVerificationMs = performance.now() - verifyStarted;
  incrementalMetrics = {
    totalFilesInspected,
    totalDomainsRehashed,
    transitionFilesInspected: totalFilesInspected - fileCount,
    transitionDomainsRehashed: totalDomainsRehashed - 7,
  };
}

// Direct truth verification happens outside runtime timing.
const expected = [];
for (let stateIndex = 0; stateIndex < states.length; stateIndex += 1) {
  const row = [];
  for (const request of requests) {
    const direct = await runDirectRealisticBaseline({
      request,
      state: states[stateIndex],
      registry: buildRealisticRegistry(),
      stateFingerprint: stateHashes[stateIndex],
    });
    row.push(direct.receipt.resultHash);
  }
  expected.push(row);
}

const session = new BudgetedRetentionSession({
  registry: buildRealisticRegistry(),
  maxCacheBytes: 900_000,
  policy: "value",
  domainBindings: REALISTIC_DOMAIN_BINDINGS,
});

let totalMaterializedBytes = 0;
let hitCount = 0;
let fullInvalidatedBytes = 0;
let domainInvalidatedBytes = 0;
let equivalent = true;
const runtimeStarted = performance.now();
try {
  for (let stateIndex = 0; stateIndex < states.length; stateIndex += 1) {
    for (let requestIndex = 0; requestIndex < requests.length; requestIndex += 1) {
      const run = await session.run({
        request: requests[requestIndex],
        state: states[stateIndex],
        stateFingerprint: stateHashes[stateIndex],
        domainIdentity: mode === "full-state" ? null : identities[stateIndex],
      });
      totalMaterializedBytes += run.receipt.materializedBytes;
      if (run.receipt.cacheHit) hitCount += 1;
      fullInvalidatedBytes += run.receipt.invalidatedForStateChange.reduce((sum, entry) => sum + entry.allocatedBytes, 0);
      domainInvalidatedBytes += run.receipt.invalidatedForDomainIdentity.reduce((sum, entry) => sum + entry.allocatedBytes, 0);
      if (run.receipt.resultHash !== expected[stateIndex][requestIndex]) equivalent = false;
    }
  }
} finally {
  await session.close({ state: states.at(-1) });
}
const runtimeWallMs = performance.now() - runtimeStarted;

const identityExtraMs = mode === "full-domain"
  ? fullDomainBuildMs
  : mode === "incremental"
    ? incrementalBootstrapMs + mutationReceiptBuildMs + incrementalUpdateMs
    : 0;

console.log(JSON.stringify({
  schema: "axm.ignition-incremental-identity-probe/v0.10",
  mode,
  scenario,
  fileCount,
  transitionCount,
  requestCount: states.length * requests.length,
  equivalent,
  runtimeWallMs,
  totalMaterializedBytes,
  hitCount,
  fullInvalidatedBytes,
  domainInvalidatedBytes,
  stateFingerprintBuildMs,
  fullDomainBuildMs,
  incrementalBootstrapMs,
  mutationReceiptBuildMs,
  incrementalUpdateMs,
  incrementalIdentityExtraMs: incrementalBootstrapMs + mutationReceiptBuildMs + incrementalUpdateMs,
  referenceBuildMs,
  referenceVerificationMs,
  incrementalMetrics,
  chargedEndToEndMs: stateFingerprintBuildMs + identityExtraMs + runtimeWallMs,
  timingBoundary: "Direct result verification is excluded. Canonical whole-state fingerprint cost is charged to all modes. Full-domain scan or incremental bootstrap/receipt/update cost is charged to its respective mode.",
  truthBoundary: "Point-incremental correctness trusts the canonical mutation scope/state hashes in the receipt, verifies the changed file entries locally, and is checked against a full-scan reference identity. Missing/structural evidence uses the tested full-recompute fallback.",
}));
