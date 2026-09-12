import { hashValue, stableStringify } from "../src/ignition-core.js";
import { buildWorkspaceState } from "../src/realistic-workload.js";
import { applyWorkspacePointMutation, buildWorkspaceDomainEntryIndex } from "../src/incremental-domain-index.js";
import { applyTrackedWorkspacePointPatch, bootstrapTrackedWorkspaceTruth } from "../src/tracked-workspace-truth.js";
import { applyUnifiedWorkspacePointPatch, bootstrapUnifiedWorkspaceTruth } from "../src/unified-workspace-truth.js";

const method = process.argv[2] || "v019";
const scenario = process.argv[3] || "middle";
if (!["v019", "v020"].includes(method)) throw new Error("method must be v019 or v020");
if (!["first", "middle", "last", "same-width-last"].includes(scenario)) throw new Error("unknown scenario");

const fileCount = 2500;
const positions = { first: 0, middle: 1250, last: 2499, "same-width-last": 2498 };
const fileIndex = positions[scenario];
const initialState = buildWorkspaceState({ fileCount });

function makePatch(state) {
  const file = state.files[fileIndex];
  if (scenario === "same-width-last") {
    if (!file.content.includes("file-2499.js")) throw new Error("same-width fixture missing file-2499.js");
    return { content: file.content.replace("file-2499.js", "file-2497.js") };
  }
  return { path: `${file.path}/v20` };
}

function identitySummary(identity) {
  return Object.fromEntries(Object.entries(identity.domains).map(([domain, entry]) => [domain, {
    hash: entry.hash,
    revision: entry.revision,
  }]));
}

let finalState;
let finalHash;
let finalSize;
let domainIdentity;
let mutationReceipt;
let fingerprintCharactersRehashed;
let fingerprintFilesRehashed;
let fingerprintFilesSkipped;
let checkpointBytes = 0;
let fingerprintMode;

if (method === "v019") {
  let tracked = bootstrapTrackedWorkspaceTruth(initialState);
  let domainIndex = buildWorkspaceDomainEntryIndex(initialState, null, { stateHash: tracked.stateHash });
  const started = performance.now();
  tracked = applyTrackedWorkspacePointPatch({
    tracked,
    fileId: initialState.files[fileIndex].id,
    patch: makePatch(initialState),
    evidence: { benchmark: "v0.20", scenario, method },
  });
  domainIndex = applyWorkspacePointMutation({
    index: domainIndex,
    mutationReceipt: tracked.lastMutation.mutationReceipt,
    nextState: tracked.state,
  });
  const wallMs = performance.now() - started;

  finalState = tracked.state;
  finalHash = tracked.stateHash;
  finalSize = tracked.canonicalSizeHint.canonicalCharacters;
  domainIdentity = domainIndex.identity;
  mutationReceipt = tracked.lastMutation.mutationReceipt;
  fingerprintCharactersRehashed = finalSize;
  fingerprintFilesRehashed = fileCount;
  fingerprintFilesSkipped = 0;
  fingerprintMode = tracked.lastMutation.fingerprint.mode;

  const referenceHash = hashValue(finalState);
  const referenceSize = stableStringify(finalState).length;
  const referenceDomain = buildWorkspaceDomainEntryIndex(finalState, buildWorkspaceDomainEntryIndex(initialState, null, { stateHash: hashValue(initialState) }).identity, { stateHash: referenceHash }).identity;
  if (referenceHash !== finalHash) throw new Error("v0.19 final hash diverged from reference");
  if (referenceSize !== finalSize) throw new Error("v0.19 final canonical size diverged from reference");
  if (JSON.stringify(identitySummary(referenceDomain)) !== JSON.stringify(identitySummary(domainIdentity))) throw new Error("v0.19 domain identity diverged from reference");

  console.log(JSON.stringify({
    schema: "axm.ignition-one-truth-advance-probe/v0.20",
    method,
    scenario,
    fileCount,
    fileIndex,
    wallMs,
    finalHash,
    finalCanonicalCharacters: finalSize,
    fingerprintCharactersRehashed,
    fingerprintFilesRehashed,
    fingerprintFilesSkipped,
    fingerprintMode,
    checkpointBytes,
    changedDomains: mutationReceipt.changedDomains,
    domainIdentity: identitySummary(domainIdentity),
    truthConsequencesAdvanced: ["canonical-size", "state-fingerprint", "domain-identity"],
    timingBoundary: "Fresh Node process. Initial workspace bootstrap and full-reference verification are excluded. Timed v0.19 path includes tracked point patch/full exact fingerprint + mutation receipt + existing v0.10 incremental domain advance.",
  }));
  process.exit(0);
}

let tracked = bootstrapUnifiedWorkspaceTruth(initialState);
const started = performance.now();
tracked = applyUnifiedWorkspacePointPatch({
  tracked,
  fileId: initialState.files[fileIndex].id,
  patch: makePatch(initialState),
  evidence: { benchmark: "v0.20", scenario, method },
});
const wallMs = performance.now() - started;

finalState = tracked.state;
finalHash = tracked.stateHash;
finalSize = tracked.canonicalSizeHint.canonicalCharacters;
domainIdentity = tracked.domainIndex.identity;
mutationReceipt = tracked.lastMutation.mutationReceipt;
fingerprintCharactersRehashed = tracked.lastMutation.fingerprintAdvance.canonicalCharactersRehashed;
fingerprintFilesRehashed = tracked.lastMutation.fingerprintAdvance.filesRehashed;
fingerprintFilesSkipped = tracked.lastMutation.fingerprintAdvance.filesSkipped;
fingerprintMode = "checkpointed-exact-fnv";
checkpointBytes = tracked.fingerprintCheckpoints.checkpointBytes;

const referenceHash = hashValue(finalState);
const referenceSize = stableStringify(finalState).length;
const initialReferenceDomain = buildWorkspaceDomainEntryIndex(initialState, null, { stateHash: hashValue(initialState) });
const referenceDomain = buildWorkspaceDomainEntryIndex(finalState, initialReferenceDomain.identity, { stateHash: referenceHash }).identity;
if (referenceHash !== finalHash) throw new Error("v0.20 final hash diverged from reference");
if (referenceSize !== finalSize) throw new Error("v0.20 final canonical size diverged from reference");
if (JSON.stringify(identitySummary(referenceDomain)) !== JSON.stringify(identitySummary(domainIdentity))) throw new Error("v0.20 domain identity diverged from reference");

console.log(JSON.stringify({
  schema: "axm.ignition-one-truth-advance-probe/v0.20",
  method,
  scenario,
  fileCount,
  fileIndex,
  wallMs,
  finalHash,
  finalCanonicalCharacters: finalSize,
  fingerprintCharactersRehashed,
  fingerprintFilesRehashed,
  fingerprintFilesSkipped,
  fingerprintMode,
  checkpointBytes,
  changedDomains: mutationReceipt.changedDomains,
  domainIdentity: identitySummary(domainIdentity),
  truthConsequencesAdvanced: tracked.lastMutation.consequencesAdvanced,
  suffixStillRehashed: tracked.lastMutation.fingerprintAdvance.suffixStillRehashed,
  timingBoundary: "Fresh Node process. Initial workspace/bootstrap checkpoint construction and full-reference verification are excluded. Timed v0.20 path includes one point mutation event advancing checkpointed exact FNV state hash + exact canonical-size hint + mutation receipt + existing v0.10 incremental domain identity.",
}));
