import { hashValue, stableStringify } from "../src/ignition-core.js";
import { buildWorkspaceState } from "../src/realistic-workload.js";
import { buildWorkspaceDomainEntryIndex } from "../src/incremental-domain-index.js";
import { REALISTIC_DOMAINS } from "../src/realistic-mutations.js";
import {
  applyDomainCheckpointedWorkspacePointPatch,
  bootstrapDomainCheckpointedWorkspaceTruth,
} from "../src/domain-checkpointed-workspace-truth.js";

const method = process.argv[2] || "none";
const scenario = process.argv[3] || "path-last";
if (!["none", "selective", "wrong", "full"].includes(method)) throw new Error("unknown domain checkpoint method");
if (!["path-first", "path-middle", "path-last", "import-last"].includes(scenario)) throw new Error("unknown domain checkpoint scenario");

const fileCount = 2500;
const positions = { "path-first": 0, "path-middle": 1250, "path-last": 2499, "import-last": 2499 };
const fileIndex = positions[scenario];
const initialState = buildWorkspaceState({ fileCount, packageCount: 25 });

function checkpointDomainsFor() {
  if (method === "none") return [];
  if (method === "full") return REALISTIC_DOMAINS;
  if (method === "wrong") return ["metadata"];
  return scenario === "import-last" ? ["content-hash", "imports"] : ["metadata"];
}

function makePatch(state) {
  const file = state.files[fileIndex];
  if (scenario === "import-last") {
    if (!file.content.includes("file-0.js")) throw new Error("import-last fixture missing file-0.js");
    return { content: file.content.replace("file-0.js", "file-1.js") };
  }
  return { path: `${file.path}/v21` };
}

function identitySummary(identity) {
  return Object.fromEntries(Object.entries(identity.domains).map(([domain, entry]) => [domain, {
    hash: entry.hash,
    revision: entry.revision,
  }]));
}

const checkpointDomains = checkpointDomainsFor();
let tracked = bootstrapDomainCheckpointedWorkspaceTruth(initialState, { checkpointDomains });
const started = performance.now();
tracked = applyDomainCheckpointedWorkspacePointPatch({
  tracked,
  fileId: initialState.files[fileIndex].id,
  patch: makePatch(initialState),
  evidence: { benchmark: "v0.21", scenario, method },
});
const wallMs = performance.now() - started;

const referenceHash = hashValue(tracked.state);
const referenceSize = stableStringify(tracked.state).length;
const initialReferenceDomain = buildWorkspaceDomainEntryIndex(initialState, null, { stateHash: hashValue(initialState) });
const referenceDomain = buildWorkspaceDomainEntryIndex(tracked.state, initialReferenceDomain.identity, { stateHash: referenceHash }).identity;
if (referenceHash !== tracked.stateHash) throw new Error("v0.21 state hash diverged from full reference");
if (referenceSize !== tracked.canonicalSizeHint.canonicalCharacters) throw new Error("v0.21 canonical size diverged from full reference");
if (JSON.stringify(identitySummary(referenceDomain)) !== JSON.stringify(identitySummary(tracked.domainIndex.identity))) {
  throw new Error("v0.21 domain identity diverged from full reference");
}
for (const domain of tracked.domainHashCheckpoints.selectedDomains) {
  if (tracked.domainHashCheckpoints.domainHash(domain) !== tracked.domainIndex.identity.domains[domain].hash) {
    throw new Error(`v0.21 selected checkpoint diverged: ${domain}`);
  }
}

console.log(JSON.stringify({
  schema: "axm.ignition-domain-checkpoint-probe/v0.21",
  method,
  scenario,
  fileCount,
  fileIndex,
  checkpointDomains,
  domainCheckpointBytes: tracked.domainHashCheckpoints.checkpointBytes,
  stateCheckpointBytes: tracked.fingerprintCheckpoints.checkpointBytes,
  wallMs,
  finalHash: tracked.stateHash,
  finalCanonicalCharacters: tracked.canonicalSizeHint.canonicalCharacters,
  changedDomains: tracked.lastMutation.mutationReceipt.changedDomains,
  domainIdentity: identitySummary(tracked.domainIndex.identity),
  stateFingerprintCharactersRehashed: tracked.lastMutation.fingerprintAdvance.canonicalCharactersRehashed,
  domainCanonicalCharactersRehashed: tracked.lastMutation.domainAdvance.totalDomainCanonicalCharactersRehashed,
  domainEntriesRehashed: tracked.lastMutation.domainAdvance.totalDomainEntriesRehashed,
  domainEntriesSkipped: tracked.lastMutation.domainAdvance.totalDomainEntriesSkipped,
  checkpointedChangedDomains: tracked.lastMutation.domainAdvance.checkpointedChangedDomains,
  fallbackChangedDomains: tracked.lastMutation.domainAdvance.fallbackChangedDomains,
  domainMetrics: tracked.lastMutation.domainAdvance.metricsByDomain,
  timingBoundary: "Fresh Node process. Workspace/state/domain checkpoint bootstrap and independent full-reference verification are excluded. Timed path includes one trusted point mutation advancing exact state fingerprint, canonical size, receipt, versioned domain identity, and selected domain checkpoints/fallback hashes.",
}));
