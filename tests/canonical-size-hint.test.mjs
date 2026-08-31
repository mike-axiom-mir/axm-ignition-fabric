import test from "node:test";
import assert from "node:assert/strict";
import { hashValue, stableStringify } from "../src/ignition-core.js";
import { selectAdaptiveFingerprintMode } from "../src/adaptive-fingerprint.js";
import {
  buildWorkspaceCanonicalSizeHint,
  canonicalStringCharacterLength,
  hashValueWithCanonicalSizeHint,
  validateWorkspaceCanonicalSizeHint,
} from "../src/canonical-size-hint.js";
import { buildWorkspaceState } from "../src/realistic-workload.js";
import {
  applyTrackedWorkspacePointPatch,
  bootstrapTrackedWorkspaceTruth,
  validateTrackedWorkspaceTruth,
} from "../src/tracked-workspace-truth.js";

const representative = [
  null,
  true,
  false,
  0,
  -0,
  123.5,
  NaN,
  "plain",
  "quote\"slash\\line\n",
  "emoji 😀",
  "lone-high-\ud800",
  "lone-low-\udc00",
  [1, undefined, , "x"],
  { z: 1, a: "two", skip: undefined, nested: [true, null] },
];

test("scalar canonical character length exactly matches stableStringify on supported representative values", () => {
  for (const value of representative) {
    const serialized = stableStringify(value);
    assert.equal(canonicalStringCharacterLength(value), serialized.length, `length mismatch for ${String(serialized)}`);
  }
});

test("workspace canonical size hint exactly matches full canonical serialization across fixture sizes", () => {
  for (const fileCount of [25, 100, 250, 2500]) {
    const state = buildWorkspaceState({ fileCount });
    const stateHash = hashValue(state);
    const hint = buildWorkspaceCanonicalSizeHint(state, { stateHash });
    assert.equal(hint.canonicalCharacters, stableStringify(state).length);
    assert.equal(hint.stateHash, stateHash);
    assert.equal(hint.fileCount, fileCount);
    assert.equal(validateWorkspaceCanonicalSizeHint(hint, { expectedStateHash: stateHash, expectedFileCount: fileCount }), true);
  }
});

test("tracked point mutation maintains exact canonical size and exact hash without adaptive preflight", () => {
  let tracked = bootstrapTrackedWorkspaceTruth(buildWorkspaceState({ fileCount: 2500 }));
  for (let i = 0; i < 6; i += 1) {
    const fileId = (i * 137) % 2500;
    const file = tracked.state.files[fileId];
    tracked = applyTrackedWorkspacePointPatch({
      tracked,
      fileId,
      patch: { path: `${file.path}/r${i}` },
      evidence: { kind: "test-path-growth", iteration: i },
    });
    assert.equal(tracked.stateHash, hashValue(tracked.state));
    assert.equal(tracked.canonicalSizeHint.canonicalCharacters, stableStringify(tracked.state).length);
    assert.equal(tracked.lastMutation.fingerprint.preflightNodesVisited, 0);
    assert.equal(tracked.lastMutation.fingerprint.mode, "streaming");
    assert.equal(validateTrackedWorkspaceTruth(tracked, { verifyHash: true, verifyCanonicalSize: true }), true);
  }
});

test("same-width import mutation keeps exact canonical size unchanged while hash truth changes", () => {
  let tracked = bootstrapTrackedWorkspaceTruth(buildWorkspaceState({ fileCount: 2500 }));
  const beforeCharacters = tracked.canonicalSizeHint.canonicalCharacters;
  const beforeHash = tracked.stateHash;
  const file = tracked.state.files[0];
  assert.ok(file.content.includes("file-1.js"));
  tracked = applyTrackedWorkspacePointPatch({
    tracked,
    fileId: 0,
    patch: { content: file.content.replace("file-1.js", "file-2.js") },
    evidence: { kind: "same-width-import" },
  });
  assert.equal(tracked.lastMutation.canonicalSizeDeltaCharacters, 0);
  assert.equal(tracked.canonicalSizeHint.canonicalCharacters, beforeCharacters);
  assert.notEqual(tracked.stateHash, beforeHash);
  assert.equal(tracked.stateHash, hashValue(tracked.state));
});

test("maintained exact size can cross the route threshold without a selection scan", () => {
  let tracked = bootstrapTrackedWorkspaceTruth(buildWorkspaceState({ fileCount: 100 }));
  assert.equal(selectAdaptiveFingerprintMode(tracked.state).mode, "monolithic");
  assert.ok(tracked.canonicalSizeHint.canonicalCharacters < 65536);
  const file = tracked.state.files[0];
  tracked = applyTrackedWorkspacePointPatch({
    tracked,
    fileId: 0,
    patch: { content: `${file.content}${"x".repeat(20000)}` },
    evidence: { kind: "threshold-crossing" },
  });
  assert.ok(tracked.canonicalSizeHint.canonicalCharacters > 65536);
  assert.equal(tracked.lastMutation.fingerprint.mode, "streaming");
  assert.equal(tracked.lastMutation.fingerprint.preflightNodesVisited, 0);
  assert.equal(tracked.stateHash, hashValue(tracked.state));
  assert.equal(tracked.canonicalSizeHint.canonicalCharacters, stableStringify(tracked.state).length);
});

test("size-hinted fingerprint remains exact on both sides of the threshold", () => {
  for (const fileCount of [100, 2500]) {
    const state = buildWorkspaceState({ fileCount });
    const canonicalCharacters = canonicalStringCharacterLength(state);
    const hinted = hashValueWithCanonicalSizeHint(state, canonicalCharacters);
    assert.equal(hinted.hash, hashValue(state));
    assert.equal(hinted.preflightNodesVisited, 0);
    assert.equal(hinted.mode, canonicalCharacters > 65536 ? "streaming" : "monolithic");
  }
});

test("tampered or stale canonical size hint is rejected instead of silently trusted", () => {
  const state = buildWorkspaceState({ fileCount: 25 });
  const stateHash = hashValue(state);
  const hint = buildWorkspaceCanonicalSizeHint(state, { stateHash });
  const tampered = { ...hint, canonicalCharacters: hint.canonicalCharacters + 1 };
  assert.throws(() => validateWorkspaceCanonicalSizeHint(tampered), /receiptHash mismatch/);
  assert.throws(() => validateWorkspaceCanonicalSizeHint(hint, { expectedStateHash: "deadbeef" }), /stateHash mismatch/);
});
