import test from "node:test";
import assert from "node:assert/strict";

import { hashValue } from "../src/ignition-core.js";
import {
  advanceWorkspaceDomainIndex,
  applyWorkspacePointMutation,
  buildWorkspaceDomainEntryIndex,
  createWorkspacePointMutationReceipt,
  validateWorkspacePointMutationReceipt,
} from "../src/incremental-domain-index.js";
import {
  REALISTIC_DOMAINS,
  changeWorkspaceImportTarget,
  changeWorkspacePath,
  createWorkspaceDomainIdentity,
} from "../src/realistic-mutations.js";
import { buildWorkspaceState } from "../src/realistic-workload.js";

function pointReceipt(before, after, fileIndex) {
  return createWorkspacePointMutationReceipt({
    beforeState: before,
    afterState: after,
    fileIndex,
    fromStateHash: hashValue(before),
    toStateHash: hashValue(after),
  });
}

test("incremental bootstrap identity equals existing full-scan v0.09 identity", () => {
  const state = buildWorkspaceState({ fileCount: 300 });
  const index = buildWorkspaceDomainEntryIndex(state, null, { stateHash: hashValue(state) });
  const reference = createWorkspaceDomainIdentity(state);
  assert.deepEqual(index.identity, reference);
  assert.equal(index.lastAdvance.filesInspected, 300);
  assert.deepEqual(index.lastAdvance.domainsRehashed, REALISTIC_DOMAINS);
});

test("path mutation inspects one file, rehashes metadata only, and equals full-scan reference", () => {
  const before = buildWorkspaceState({ fileCount: 500 });
  const after = changeWorkspacePath(before, 17, ".v2");
  const index = buildWorkspaceDomainEntryIndex(before, null, { stateHash: hashValue(before) });
  const receipt = pointReceipt(before, after, 17);
  const advanced = applyWorkspacePointMutation({ index, mutationReceipt: receipt, nextState: after });
  const reference = createWorkspaceDomainIdentity(after, index.identity);

  assert.deepEqual(receipt.changedDomains, ["metadata"]);
  assert.deepEqual(advanced.identity, reference);
  assert.equal(advanced.lastAdvance.filesInspected, 1);
  assert.deepEqual(advanced.lastAdvance.domainsRehashed, ["metadata"]);
  assert.strictEqual(advanced.entriesByDomain.imports, index.entriesByDomain.imports);
  assert.strictEqual(advanced.entriesByDomain.tokens, index.entriesByDomain.tokens);
  assert.notStrictEqual(advanced.entriesByDomain.metadata, index.entriesByDomain.metadata);
});

test("import mutation rehashes imports and content-hash only and equals full-scan reference", () => {
  const before = buildWorkspaceState({ fileCount: 500 });
  const after = changeWorkspaceImportTarget(before, 12, 13, 14);
  const index = buildWorkspaceDomainEntryIndex(before, null, { stateHash: hashValue(before) });
  const receipt = pointReceipt(before, after, 12);
  const advanced = applyWorkspacePointMutation({ index, mutationReceipt: receipt, nextState: after });
  const reference = createWorkspaceDomainIdentity(after, index.identity);

  assert.deepEqual(receipt.changedDomains, ["content-hash", "imports"]);
  assert.deepEqual(advanced.identity, reference);
  assert.deepEqual(advanced.lastAdvance.domainsRehashed, ["content-hash", "imports"]);
  assert.strictEqual(advanced.entriesByDomain.tokens, index.entriesByDomain.tokens);
  assert.strictEqual(advanced.entriesByDomain.symbols, index.entriesByDomain.symbols);
});

test("stale point receipt is rejected against the current canonical identity", () => {
  const before = buildWorkspaceState({ fileCount: 200 });
  const afterA = changeWorkspacePath(before, 17, ".a");
  const afterB = changeWorkspacePath(afterA, 17, ".b");
  const index = buildWorkspaceDomainEntryIndex(before, null, { stateHash: hashValue(before) });
  const first = pointReceipt(before, afterA, 17);
  const advanced = applyWorkspacePointMutation({ index, mutationReceipt: first, nextState: afterA });
  const stale = pointReceipt(before, afterB, 17);

  assert.throws(
    () => applyWorkspacePointMutation({ index: advanced, mutationReceipt: stale, nextState: afterB }),
    /fromStateHash mismatch/
  );
});

test("tampered point receipt is rejected by its deterministic receipt hash", () => {
  const before = buildWorkspaceState({ fileCount: 200 });
  const after = changeWorkspacePath(before, 17, ".a");
  const receipt = pointReceipt(before, after, 17);
  const tampered = {
    ...receipt,
    evidence: { tampered: true },
  };
  assert.throws(() => validateWorkspacePointMutationReceipt(tampered), /receipt hash mismatch/);
});

test("receipt is rejected when the actual target file does not match its after entries", () => {
  const before = buildWorkspaceState({ fileCount: 200 });
  const after = changeWorkspacePath(before, 17, ".a");
  const wrongAfter = changeWorkspacePath(before, 17, ".different");
  const index = buildWorkspaceDomainEntryIndex(before, null, { stateHash: hashValue(before) });
  const receipt = pointReceipt(before, after, 17);

  assert.throws(
    () => applyWorkspacePointMutation({ index, mutationReceipt: receipt, nextState: wrongAfter }),
    /target entry mismatch/
  );
});

test("missing mutation evidence falls back to full recomputation and exact reference identity", () => {
  const before = buildWorkspaceState({ fileCount: 240 });
  const after = changeWorkspacePath(before, 17, ".fallback");
  const index = buildWorkspaceDomainEntryIndex(before, null, { stateHash: hashValue(before) });
  const advanced = advanceWorkspaceDomainIndex({
    index,
    nextState: after,
    mutationReceipt: null,
    stateHash: hashValue(after),
  });
  const reference = createWorkspaceDomainIdentity(after, index.identity);

  assert.equal(advanced.lastAdvance.mode, "full-recompute-fallback");
  assert.equal(advanced.lastAdvance.filesInspected, 240);
  assert.deepEqual(advanced.identity, reference);
});

test("structural reorder is not representable as a point receipt and safely uses full fallback", () => {
  const before = buildWorkspaceState({ fileCount: 60 });
  const files = [...before.files];
  [files[1], files[2]] = [files[2], files[1]];
  const after = { ...before, files };
  const index = buildWorkspaceDomainEntryIndex(before, null, { stateHash: hashValue(before) });

  assert.throws(
    () => createWorkspacePointMutationReceipt({ beforeState: before, afterState: after, fileIndex: 1 }),
    /cannot reorder or replace file identity/
  );

  const advanced = advanceWorkspaceDomainIndex({ index, nextState: after, stateHash: hashValue(after) });
  const reference = createWorkspaceDomainIdentity(after, index.identity);
  assert.deepEqual(advanced.identity, reference);
  assert.deepEqual(
    REALISTIC_DOMAINS.filter((domain) => advanced.identity.domains[domain].revision !== index.identity.domains[domain].revision),
    REALISTIC_DOMAINS
  );
});
