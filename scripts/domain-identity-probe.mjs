import { BudgetedRetentionSession } from "../src/budgeted-retention.js";
import { hashValue } from "../src/ignition-core.js";
import { runDirectRealisticBaseline } from "../src/direct-realistic-baseline.js";
import {
  REALISTIC_DOMAIN_BINDINGS,
  changeWorkspaceImportTarget,
  changeWorkspacePath,
  createWorkspaceDomainIdentity,
} from "../src/realistic-mutations.js";
import { buildRealisticRegistry, buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";

const mode = process.argv[2] || "domain";
const scenario = process.argv[3] || "path";
const transitionCount = Number(process.argv[4] || 6);
const fileCount = Number(process.argv[5] || 2500);
if (!["full", "domain"].includes(mode)) throw new Error("mode must be full or domain");
if (!["path", "import"].includes(scenario)) throw new Error("scenario must be path or import");

function buildStates() {
  const states = [buildWorkspaceState({ fileCount })];
  for (let i = 0; i < transitionCount; i += 1) {
    const current = states.at(-1);
    if (scenario === "path") {
      states.push(changeWorkspacePath(current, 17, `.v${i + 1}`));
    } else {
      const fileId = 12;
      const originalTarget = (fileId + 1) % fileCount;
      const target = (originalTarget + i + 1) % fileCount;
      const previous = i === 0 ? originalTarget : (originalTarget + i) % fileCount;
      states.push(changeWorkspaceImportTarget(current, fileId, previous, target));
    }
  }
  return states;
}

const states = buildStates();
const fingerprintStarted = performance.now();
const stateHashes = states.map((state) => hashValue(state));
const stateFingerprintBuildMs = performance.now() - fingerprintStarted;

const domainStarted = performance.now();
const identities = [];
for (let i = 0; i < states.length; i += 1) {
  identities.push(createWorkspaceDomainIdentity(states[i], identities[i - 1] || null));
}
const domainIdentityBuildMs = performance.now() - domainStarted;

const requests = scenario === "path"
  ? [realisticRequests.search, { kind: "metadata" }]
  : [realisticRequests.search, realisticRequests.dependencies];

// Establish direct truth before timing the retention strategies.
const expectedHashes = [];
for (let i = 0; i < states.length; i += 1) {
  expectedHashes[i] = [];
  for (let j = 0; j < requests.length; j += 1) {
    const direct = await runDirectRealisticBaseline({
      request: requests[j],
      state: states[i],
      registry: buildRealisticRegistry(),
      stateFingerprint: stateHashes[i],
    });
    expectedHashes[i][j] = direct.receipt.resultHash;
  }
}

const session = new BudgetedRetentionSession({
  registry: buildRealisticRegistry(),
  maxCacheBytes: 900_000,
  policy: "value",
  domainBindings: REALISTIC_DOMAIN_BINDINGS,
});

let materializedBytes = 0;
let hitCount = 0;
let fullInvalidatedBytes = 0;
let domainInvalidatedBytes = 0;
let equivalent = true;
const transitionReceipts = [];

const started = performance.now();
try {
  for (let i = 0; i < states.length; i += 1) {
    for (let j = 0; j < requests.length; j += 1) {
      const request = requests[j];
      const run = await session.run({
        request,
        state: states[i],
        stateFingerprint: stateHashes[i],
        domainIdentity: mode === "domain" ? identities[i] : null,
      });
      if (run.receipt.resultHash !== expectedHashes[i][j]) equivalent = false;
      materializedBytes += run.receipt.materializedBytes;
      if (run.receipt.cacheHit) hitCount += 1;
      fullInvalidatedBytes += run.receipt.invalidatedForStateChange.reduce((sum, entry) => sum + entry.allocatedBytes, 0);
      domainInvalidatedBytes += run.receipt.invalidatedForDomainIdentity.reduce((sum, entry) => sum + entry.allocatedBytes, 0);
      if (i > 0) {
        transitionReceipts.push({
          stateIndex: i,
          kind: request.kind,
          cacheHit: run.receipt.cacheHit,
          materializedBytes: run.receipt.materializedBytes,
          fullInvalidatedBytes: run.receipt.invalidatedForStateChange.reduce((sum, entry) => sum + entry.allocatedBytes, 0),
          domainInvalidatedCapabilityIds: run.receipt.invalidatedForDomainIdentity.map((entry) => entry.capabilityId),
          domainInvalidatedBytes: run.receipt.invalidatedForDomainIdentity.reduce((sum, entry) => sum + entry.allocatedBytes, 0),
          cacheBytesAfter: run.receipt.cacheBytesAfter,
          bodyIdentityHash: run.receipt.bodyIdentityHash,
          resultHash: run.receipt.resultHash,
          expectedResultHash: expectedHashes[i][j],
        });
      }
    }
  }
} finally {
  await session.close({ state: states.at(-1) });
}
const runtimeWallMs = performance.now() - started;

console.log(JSON.stringify({
  schema: "axm.ignition-domain-identity-probe/v0.09",
  mode,
  scenario,
  fileCount,
  transitionCount,
  requestCount: states.length * requests.length,
  equivalent,
  runtimeWallMs,
  materializedBytes,
  hitCount,
  fullInvalidatedBytes,
  domainInvalidatedBytes,
  stateFingerprintBuildMs,
  domainIdentityBuildMs,
  finalDomainRevisions: Object.fromEntries(Object.entries(identities.at(-1).domains).map(([name, entry]) => [name, entry.revision])),
  transitionReceipts,
  timingBoundary: "Runtime timing excludes direct verification and identity construction. Whole-state fingerprint and domain-identity construction costs are reported separately.",
}));

if (!equivalent) process.exitCode = 1;
