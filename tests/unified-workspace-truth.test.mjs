import test from "node:test";
import assert from "node:assert/strict";
import { hashValue, stableStringify } from "../src/ignition-core.js";
import { buildWorkspaceState } from "../src/realistic-workload.js";
import { buildWorkspaceDomainEntryIndex } from "../src/incremental-domain-index.js";
import { buildWorkspaceFingerprintCheckpoints } from "../src/checkpointed-workspace-fingerprint.js";
import {
  applyUnifiedWorkspacePointPatch,
  bootstrapUnifiedWorkspaceTruth,
  validateUnifiedWorkspaceTruth,
} from "../src/unified-workspace-truth.js";

function patchAt(state, fileIndex, patch) {
  const files = [...state.files];
  files[fileIndex] = { ...files[fileIndex], ...patch, id: files[fileIndex].id };
  return { ...state, files };
}

function assertDomainIdentityEquivalent(actual, expected) {
  assert.equal(actual.stateHash, expected.stateHash);
  assert.deepEqual(Object.keys(actual.domains).sort(), Object.keys(expected.domains).sort());
  for (const domain of Object.keys(expected.domains)) {
    assert.equal(actual.domains[domain].hash, expected.domains[domain].hash, `domain hash mismatch: ${domain}`);
    assert.equal(actual.domains[domain].revision, expected.domains[domain].revision, `domain revision mismatch: ${domain}`);
  }
}

test("checkpoint bootstrap preserves the exact existing canonical FNV hash across workspace sizes", () => {
  for (const fileCount of [1, 25, 100, 2500]) {
    const state = buildWorkspaceState({ fileCount });
    const checkpoints = buildWorkspaceFingerprintCheckpoints(state);
    assert.equal(checkpoints.stateHash, hashValue(state));
    assert.equal(checkpoints.lastAdvance.canonicalCharactersRehashed, stableStringify(state).length);
    assert.equal(checkpoints.checkpointBytes, fileCount * 4);
  }
});

test("checkpointed point mutation preserves exact hash for first, middle, and last file", () => {
  const state = buildWorkspaceState({ fileCount: 2500 });
  const base = buildWorkspaceFingerprintCheckpoints(state);
  for (const fileIndex of [0, 1250, 2499]) {
    const next = patchAt(state, fileIndex, { path: `${state.files[fileIndex].path}/v20` });
    const advanced = base.advancePointMutation({ beforeState: state, afterState: next, fileIndex });
    assert.equal(advanced.stateHash, hashValue(next));
    assert.equal(advanced.lastAdvance.fileIndex, fileIndex);
    assert.equal(advanced.lastAdvance.filesSkipped, fileIndex);
    assert.equal(advanced.lastAdvance.filesRehashed, 2500 - fileIndex);
    assert.equal(advanced.lastAdvance.suffixStillRehashed, true);
  }
});

test("checkpoint reuse is position-sensitive rather than pretending every mutation becomes O(1)", () => {
  const state = buildWorkspaceState({ fileCount: 2500 });
  const base = buildWorkspaceFingerprintCheckpoints(state);
  const advances = [0, 1250, 2499].map((fileIndex) => {
    const next = patchAt(state, fileIndex, { path: `${state.files[fileIndex].path}/position` });
    return base.advancePointMutation({ beforeState: state, afterState: next, fileIndex }).lastAdvance;
  });
  assert.ok(advances[0].canonicalCharactersRehashed > advances[1].canonicalCharactersRehashed);
  assert.ok(advances[1].canonicalCharactersRehashed > advances[2].canonicalCharactersRehashed);
  assert.equal(advances[0].filesRehashed, 2500);
  assert.equal(advances[2].filesRehashed, 1);
});

test("checkpointed hashing preserves Unicode and escaping compatibility in a changed file", () => {
  const state = buildWorkspaceState({ fileCount: 25 });
  const base = buildWorkspaceFingerprintCheckpoints(state);
  const next = patchAt(state, 17, {
    path: `${state.files[17].path}/quote\"slash\\emoji😀`,
    content: `${state.files[17].content}\nexport const weird = "😀\\n\\ud800";`,
  });
  const advanced = base.advancePointMutation({ beforeState: state, afterState: next, fileIndex: 17 });
  assert.equal(advanced.stateHash, hashValue(next));
});

test("successive checkpointed mutations refresh downstream checkpoints exactly", () => {
  let state = buildWorkspaceState({ fileCount: 2500 });
  let checkpoints = buildWorkspaceFingerprintCheckpoints(state);
  for (const fileIndex of [2400, 2499, 1250, 2498]) {
    const next = patchAt(state, fileIndex, { path: `${state.files[fileIndex].path}/g${fileIndex}` });
    checkpoints = checkpoints.advancePointMutation({ beforeState: state, afterState: next, fileIndex });
    state = next;
    assert.equal(checkpoints.stateHash, hashValue(state));
  }
});

test("one unified mutation advances canonical size, exact state hash, and domain identity from one event", () => {
  let tracked = bootstrapUnifiedWorkspaceTruth(buildWorkspaceState({ fileCount: 2500 }));
  const beforeIdentity = tracked.domainIndex.identity;
  const file = tracked.state.files[2499];
  tracked = applyUnifiedWorkspacePointPatch({
    tracked,
    fileId: file.id,
    patch: { path: `${file.path}/unified` },
    evidence: { kind: "test-unified-path" },
  });

  assert.equal(tracked.stateHash, hashValue(tracked.state));
  assert.equal(tracked.canonicalSizeHint.canonicalCharacters, stableStringify(tracked.state).length);
  assert.equal(tracked.domainIndex.identity.stateHash, tracked.stateHash);
  assert.deepEqual(tracked.lastMutation.consequencesAdvanced, ["canonical-size", "state-fingerprint", "domain-identity"]);
  assert.equal(tracked.lastMutation.fingerprintAdvance.filesRehashed, 1);

  const reference = buildWorkspaceDomainEntryIndex(tracked.state, beforeIdentity, { stateHash: tracked.stateHash });
  assertDomainIdentityEquivalent(tracked.domainIndex.identity, reference.identity);
  assert.equal(validateUnifiedWorkspaceTruth(tracked, { verifyHash: true, verifyCanonicalSize: true, verifyDomainIdentity: true }), true);
});

test("same-width import mutation can keep canonical size while unified hash and domain truth advance", () => {
  let tracked = bootstrapUnifiedWorkspaceTruth(buildWorkspaceState({ fileCount: 2500 }));
  const beforeCharacters = tracked.canonicalSizeHint.canonicalCharacters;
  const beforeHash = tracked.stateHash;
  const file = tracked.state.files[2498];
  assert.ok(file.content.includes("file-2499.js"));
  tracked = applyUnifiedWorkspacePointPatch({
    tracked,
    fileId: file.id,
    patch: { content: file.content.replace("file-2499.js", "file-2497.js") },
    evidence: { kind: "test-unified-same-width" },
  });
  assert.equal(tracked.canonicalSizeHint.canonicalCharacters, beforeCharacters);
  assert.notEqual(tracked.stateHash, beforeHash);
  assert.equal(tracked.stateHash, hashValue(tracked.state));
  assert.deepEqual([...tracked.lastMutation.domainAdvance.domainsRehashed].sort(), ["content-hash", "imports"].sort());
});

test("checkpoint path rejects structural envelope changes instead of guessing compatibility", () => {
  const state = buildWorkspaceState({ fileCount: 25 });
  const base = buildWorkspaceFingerprintCheckpoints(state);
  const next = { ...patchAt(state, 10, { path: `${state.files[10].path}/x` }), extraTopLevel: true };
  assert.throws(
    () => base.advancePointMutation({ beforeState: state, afterState: next, fileIndex: 10 }),
    /top-level key layout/
  );
});
