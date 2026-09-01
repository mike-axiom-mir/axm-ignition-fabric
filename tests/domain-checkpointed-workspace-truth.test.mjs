import test from "node:test";
import assert from "node:assert/strict";

import { buildWorkspaceState } from "../src/realistic-workload.js";
import { REALISTIC_DOMAINS } from "../src/realistic-mutations.js";
import {
  applyUnifiedWorkspacePointPatch,
  bootstrapUnifiedWorkspaceTruth,
} from "../src/unified-workspace-truth.js";
import {
  applyDomainCheckpointedWorkspacePointPatch,
  bootstrapDomainCheckpointedWorkspaceTruth,
  validateDomainCheckpointedWorkspaceTruth,
} from "../src/domain-checkpointed-workspace-truth.js";

function identityVector(tracked) {
  return Object.fromEntries(
    Object.entries(tracked.domainIndex.identity.domains).map(([domain, entry]) => [domain, { hash: entry.hash, revision: entry.revision }])
  );
}

function pathPatch(state, fileId, suffix) {
  const file = state.files.find((entry) => entry.id === fileId);
  return { path: `${file.path}${suffix}` };
}

function sameWidthImportPatch(state, fileId, fromTarget, toTarget) {
  const file = state.files.find((entry) => entry.id === fileId);
  const needle = `file-${fromTarget}.js`;
  const replacement = `file-${toTarget}.js`;
  assert.equal(needle.length, replacement.length);
  assert.ok(file.content.includes(needle));
  return { content: file.content.replace(needle, replacement) };
}

test("domain checkpoint bootstrap costs 0, 10 KB, 20 KB, or 70 KB without changing truth", () => {
  const state = buildWorkspaceState({ fileCount: 2500, packageCount: 25 });
  const none = bootstrapDomainCheckpointedWorkspaceTruth(state);
  const metadata = bootstrapDomainCheckpointedWorkspaceTruth(state, { checkpointDomains: ["metadata"] });
  const importPair = bootstrapDomainCheckpointedWorkspaceTruth(state, { checkpointDomains: ["content-hash", "imports"] });
  const full = bootstrapDomainCheckpointedWorkspaceTruth(state, { checkpointDomains: REALISTIC_DOMAINS });

  assert.equal(none.domainHashCheckpoints.checkpointBytes, 0);
  assert.equal(metadata.domainHashCheckpoints.checkpointBytes, 10_000);
  assert.equal(importPair.domainHashCheckpoints.checkpointBytes, 20_000);
  assert.equal(full.domainHashCheckpoints.checkpointBytes, 70_000);
  assert.equal(none.stateHash, metadata.stateHash);
  assert.equal(metadata.stateHash, importPair.stateHash);
  assert.equal(importPair.stateHash, full.stateHash);
  assert.deepEqual(identityVector(none), identityVector(full));
  validateDomainCheckpointedWorkspaceTruth(full, { verifyHash: true, verifyCanonicalSize: true, verifyDomainIdentity: true, verifyDomainCheckpoints: true });
});

test("last-file path mutation gets exact metadata-domain reuse from 10 KB selective checkpoints", () => {
  const state = buildWorkspaceState({ fileCount: 2500, packageCount: 25 });
  const fileId = 2499;
  const patch = pathPatch(state, fileId, "-v21");
  const baseline = applyUnifiedWorkspacePointPatch({ tracked: bootstrapUnifiedWorkspaceTruth(state), fileId, patch });
  const selective = applyDomainCheckpointedWorkspacePointPatch({
    tracked: bootstrapDomainCheckpointedWorkspaceTruth(state, { checkpointDomains: ["metadata"] }),
    fileId,
    patch,
  });
  const full = applyDomainCheckpointedWorkspacePointPatch({
    tracked: bootstrapDomainCheckpointedWorkspaceTruth(state, { checkpointDomains: REALISTIC_DOMAINS }),
    fileId,
    patch,
  });

  assert.equal(selective.stateHash, baseline.stateHash);
  assert.equal(full.stateHash, baseline.stateHash);
  assert.deepEqual(identityVector(selective), identityVector(baseline));
  assert.deepEqual(identityVector(full), identityVector(baseline));
  assert.deepEqual(selective.lastMutation.domainAdvance.checkpointedChangedDomains, ["metadata"]);
  assert.deepEqual(selective.lastMutation.domainAdvance.fallbackChangedDomains, []);
  assert.equal(selective.lastMutation.domainAdvance.totalDomainEntriesRehashed, 1);
  assert.equal(selective.lastMutation.domainAdvance.totalDomainEntriesSkipped, 2499);
  assert.equal(selective.domainHashCheckpoints.checkpointBytes, 10_000);
  assert.equal(full.domainHashCheckpoints.checkpointBytes, 70_000);
  assert.equal(
    selective.lastMutation.domainAdvance.totalDomainCanonicalCharactersRehashed,
    full.lastMutation.domainAdvance.totalDomainCanonicalCharactersRehashed,
  );
  validateDomainCheckpointedWorkspaceTruth(selective, { verifyHash: true, verifyCanonicalSize: true, verifyDomainIdentity: true, verifyDomainCheckpoints: true });
});

test("first-file path mutation preserves the sequential no-skip counterexample", () => {
  const state = buildWorkspaceState({ fileCount: 2500, packageCount: 25 });
  const patch = pathPatch(state, 0, "-v21");
  const none = applyDomainCheckpointedWorkspacePointPatch({ tracked: bootstrapDomainCheckpointedWorkspaceTruth(state), fileId: 0, patch });
  const selective = applyDomainCheckpointedWorkspacePointPatch({
    tracked: bootstrapDomainCheckpointedWorkspaceTruth(state, { checkpointDomains: ["metadata"] }),
    fileId: 0,
    patch,
  });

  assert.equal(selective.stateHash, none.stateHash);
  assert.deepEqual(identityVector(selective), identityVector(none));
  assert.equal(selective.lastMutation.domainAdvance.totalDomainEntriesSkipped, 0);
  assert.equal(selective.lastMutation.domainAdvance.totalDomainEntriesRehashed, 2500);
  assert.equal(none.lastMutation.domainAdvance.totalDomainEntriesRehashed, 2500);
  assert.ok(selective.lastMutation.domainAdvance.totalDomainCanonicalCharactersRehashed < none.lastMutation.domainAdvance.totalDomainCanonicalCharactersRehashed);
  assert.ok(
    none.lastMutation.domainAdvance.totalDomainCanonicalCharactersRehashed
      - selective.lastMutation.domainAdvance.totalDomainCanonicalCharactersRehashed
      < 100,
  );
});

test("wrong metadata checkpoint does nothing useful for a same-width import mutation", () => {
  const state = buildWorkspaceState({ fileCount: 2500, packageCount: 25 });
  const fileId = 2499;
  const patch = sameWidthImportPatch(state, fileId, 0, 1);
  const none = applyDomainCheckpointedWorkspacePointPatch({ tracked: bootstrapDomainCheckpointedWorkspaceTruth(state), fileId, patch });
  const wrong = applyDomainCheckpointedWorkspacePointPatch({
    tracked: bootstrapDomainCheckpointedWorkspaceTruth(state, { checkpointDomains: ["metadata"] }),
    fileId,
    patch,
  });

  assert.equal(wrong.stateHash, none.stateHash);
  assert.deepEqual(identityVector(wrong), identityVector(none));
  assert.deepEqual(wrong.lastMutation.domainAdvance.checkpointedChangedDomains, []);
  assert.deepEqual(wrong.lastMutation.domainAdvance.fallbackChangedDomains, ["content-hash", "imports"]);
  assert.equal(wrong.lastMutation.domainAdvance.totalDomainEntriesRehashed, 5000);
  assert.equal(wrong.lastMutation.domainAdvance.totalDomainEntriesSkipped, 0);
  assert.equal(wrong.lastMutation.domainAdvance.totalDomainCanonicalCharactersRehashed, none.lastMutation.domainAdvance.totalDomainCanonicalCharactersRehashed);
  assert.equal(wrong.domainHashCheckpoints.checkpointBytes, 10_000);
});

test("20 KB import-pair checkpoints preserve the same exact truth as 70 KB full checkpoints", () => {
  const state = buildWorkspaceState({ fileCount: 2500, packageCount: 25 });
  const fileId = 2499;
  const patch = sameWidthImportPatch(state, fileId, 0, 1);
  const selective = applyDomainCheckpointedWorkspacePointPatch({
    tracked: bootstrapDomainCheckpointedWorkspaceTruth(state, { checkpointDomains: ["content-hash", "imports"] }),
    fileId,
    patch,
  });
  const full = applyDomainCheckpointedWorkspacePointPatch({
    tracked: bootstrapDomainCheckpointedWorkspaceTruth(state, { checkpointDomains: REALISTIC_DOMAINS }),
    fileId,
    patch,
  });

  assert.equal(selective.stateHash, full.stateHash);
  assert.equal(selective.canonicalSizeHint.canonicalCharacters, full.canonicalSizeHint.canonicalCharacters);
  assert.deepEqual(identityVector(selective), identityVector(full));
  assert.deepEqual(selective.lastMutation.domainAdvance.checkpointedChangedDomains, ["content-hash", "imports"]);
  assert.equal(selective.lastMutation.domainAdvance.totalDomainEntriesRehashed, 2);
  assert.equal(selective.lastMutation.domainAdvance.totalDomainEntriesSkipped, 4998);
  assert.equal(selective.domainHashCheckpoints.checkpointBytes, 20_000);
  assert.equal(full.domainHashCheckpoints.checkpointBytes, 70_000);
  assert.equal(
    selective.lastMutation.domainAdvance.totalDomainCanonicalCharactersRehashed,
    full.lastMutation.domainAdvance.totalDomainCanonicalCharactersRehashed,
  );
  validateDomainCheckpointedWorkspaceTruth(selective, { verifyHash: true, verifyCanonicalSize: true, verifyDomainIdentity: true, verifyDomainCheckpoints: true });
});

test("successive selective checkpoint mutations refresh exact downstream domain checkpoints", () => {
  const state = buildWorkspaceState({ fileCount: 2500, packageCount: 25 });
  let tracked = bootstrapDomainCheckpointedWorkspaceTruth(state, { checkpointDomains: ["metadata"] });
  tracked = applyDomainCheckpointedWorkspacePointPatch({ tracked, fileId: 2400, patch: pathPatch(tracked.state, 2400, "-a") });
  tracked = applyDomainCheckpointedWorkspacePointPatch({ tracked, fileId: 2499, patch: pathPatch(tracked.state, 2499, "-b") });
  validateDomainCheckpointedWorkspaceTruth(tracked, { verifyHash: true, verifyCanonicalSize: true, verifyDomainIdentity: true, verifyDomainCheckpoints: true });
  assert.equal(tracked.generation, 2);
  assert.equal(tracked.domainHashCheckpoints.generation, 2);
});
