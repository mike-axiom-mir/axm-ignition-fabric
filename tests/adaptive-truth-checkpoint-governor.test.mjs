import test from "node:test";
import assert from "node:assert/strict";

import { AdaptiveTruthCheckpointGovernor } from "../src/adaptive-truth-checkpoint-governor.js";
import { buildWorkspaceState } from "../src/realistic-workload.js";
import {
  applyDomainCheckpointedWorkspacePointPatch,
  bootstrapDomainCheckpointedWorkspaceTruth,
  validateDomainCheckpointedWorkspaceTruth,
} from "../src/domain-checkpointed-workspace-truth.js";

function pathPatch(state, fileId, suffix) {
  const file = state.files.find((entry) => entry.id === fileId);
  assert.ok(file);
  return { path: `${file.path}${suffix}` };
}

function importTogglePatch(state, fileId, fromTarget, toTarget) {
  const file = state.files.find((entry) => entry.id === fileId);
  assert.ok(file);
  const needle = `file-${fromTarget}.js`;
  const replacement = `file-${toTarget}.js`;
  assert.equal(needle.length, replacement.length);
  assert.ok(file.content.includes(needle));
  return { content: file.content.replace(needle, replacement) };
}

function identityVector(tracked) {
  return Object.fromEntries(Object.entries(tracked.domainIndex.identity.domains).map(([domain, entry]) => [domain, {
    hash: entry.hash,
    revision: entry.revision,
  }]));
}

function applyEarlyMetadata(governor, count = 6) {
  for (let i = 0; i < count; i += 1) {
    governor.applyPointPatch({
      fileId: 0,
      patch: pathPatch(governor.tracked.state, 0, `-early-${i}`),
      evidence: { test: "v0.22-early-metadata", i },
    });
  }
}

function applyLateImport(governor, iteration) {
  const even = iteration % 2 === 0;
  return governor.applyPointPatch({
    fileId: 2499,
    patch: importTogglePatch(governor.tracked.state, 2499, even ? 0 : 1, even ? 1 : 0),
    evidence: { test: "v0.22-late-import", iteration },
  });
}

test("hard 20 KB checkpoint budget is never exceeded", () => {
  const state = buildWorkspaceState({ fileCount: 2500, packageCount: 25 });
  const governor = new AdaptiveTruthCheckpointGovernor({ state, maxCheckpointBytes: 20_000, valueWindow: 4 });
  applyEarlyMetadata(governor, 6);
  for (let i = 0; i < 4; i += 1) {
    const { decision } = applyLateImport(governor, i);
    assert.ok(decision.persistentCheckpointBytes <= 20_000);
  }
  assert.ok(governor.summary().persistentCheckpointBytes <= 20_000);
});

test("frequent first-file metadata changes do not earn checkpoint bytes", () => {
  const state = buildWorkspaceState({ fileCount: 2500, packageCount: 25 });
  const governor = new AdaptiveTruthCheckpointGovernor({ state, maxCheckpointBytes: 20_000, valueWindow: 4 });
  applyEarlyMetadata(governor, 6);
  const summary = governor.summary();
  assert.deepEqual(summary.selectedDomains, []);
  assert.equal(summary.persistentCheckpointBytes, 0);
  assert.equal(summary.stats.metadata.mutationCount, 6);
  assert.equal(summary.stats.metadata.recentOpportunityTotal, 0);
  assert.equal(summary.reconfigurationCount, 0);
});

test("rarer near-tail import truth beats more frequent low-value metadata", () => {
  const state = buildWorkspaceState({ fileCount: 2500, packageCount: 25 });
  const governor = new AdaptiveTruthCheckpointGovernor({ state, maxCheckpointBytes: 20_000, valueWindow: 4 });
  applyEarlyMetadata(governor, 6);

  applyLateImport(governor, 0);
  assert.deepEqual(governor.summary().selectedDomains, []);
  const second = applyLateImport(governor, 1);
  assert.deepEqual(second.decision.selectedAfter, ["content-hash", "imports"]);
  assert.equal(second.decision.persistentCheckpointBytes, 20_000);
  assert.ok(second.decision.reconfiguration);
  assert.deepEqual(second.decision.reconfiguration.addedDomains, ["content-hash", "imports"]);

  const third = applyLateImport(governor, 2);
  assert.deepEqual(third.tracked.lastMutation.domainAdvance.checkpointedChangedDomains, ["content-hash", "imports"]);
  assert.equal(third.tracked.lastMutation.domainAdvance.totalDomainEntriesRehashed, 2);
  assert.equal(third.tracked.lastMutation.domainAdvance.totalDomainEntriesSkipped, 4998);
  assert.ok(third.tracked.lastMutation.domainAdvance.totalDomainCanonicalCharactersRehashed < 100);
});

test("adaptive truth remains exact against a no-domain-checkpoint reference", () => {
  const state = buildWorkspaceState({ fileCount: 2500, packageCount: 25 });
  const governor = new AdaptiveTruthCheckpointGovernor({ state, maxCheckpointBytes: 20_000, valueWindow: 4 });
  let reference = bootstrapDomainCheckpointedWorkspaceTruth(state, { checkpointDomains: [] });

  const operations = [];
  for (let i = 0; i < 6; i += 1) operations.push({ kind: "path", fileId: 0, suffix: `-exact-${i}` });
  for (let i = 0; i < 4; i += 1) operations.push({ kind: "import", fileId: 2499, iteration: i });

  for (const operation of operations) {
    let adaptivePatch;
    let referencePatch;
    if (operation.kind === "path") {
      adaptivePatch = pathPatch(governor.tracked.state, operation.fileId, operation.suffix);
      referencePatch = pathPatch(reference.state, operation.fileId, operation.suffix);
    } else {
      const even = operation.iteration % 2 === 0;
      adaptivePatch = importTogglePatch(governor.tracked.state, operation.fileId, even ? 0 : 1, even ? 1 : 0);
      referencePatch = importTogglePatch(reference.state, operation.fileId, even ? 0 : 1, even ? 1 : 0);
    }
    governor.applyPointPatch({ fileId: operation.fileId, patch: adaptivePatch });
    reference = applyDomainCheckpointedWorkspacePointPatch({ tracked: reference, fileId: operation.fileId, patch: referencePatch });
  }

  assert.equal(governor.tracked.stateHash, reference.stateHash);
  assert.equal(governor.tracked.canonicalSizeHint.canonicalCharacters, reference.canonicalSizeHint.canonicalCharacters);
  assert.deepEqual(identityVector(governor.tracked), identityVector(reference));
  validateDomainCheckpointedWorkspaceTruth(governor.tracked, {
    verifyHash: true,
    verifyCanonicalSize: true,
    verifyDomainIdentity: true,
    verifyDomainCheckpoints: true,
  });
});

test("recent-value window can evict stale import checkpoints after workload phase shift", () => {
  const state = buildWorkspaceState({ fileCount: 2500, packageCount: 25 });
  const governor = new AdaptiveTruthCheckpointGovernor({ state, maxCheckpointBytes: 20_000, valueWindow: 4 });
  for (let i = 0; i < 4; i += 1) applyLateImport(governor, i);
  assert.deepEqual(governor.summary().selectedDomains, ["content-hash", "imports"]);

  for (let i = 0; i < 5; i += 1) {
    governor.applyPointPatch({
      fileId: 2499,
      patch: pathPatch(governor.tracked.state, 2499, `-late-metadata-${i}`),
      evidence: { test: "v0.22-phase-shift", i },
    });
  }

  const summary = governor.summary();
  assert.deepEqual(summary.selectedDomains, ["metadata"]);
  assert.equal(summary.persistentCheckpointBytes, 10_000);
  assert.ok(summary.totalCheckpointBytesEvicted >= 20_000);
  assert.ok(summary.reconfigurationCount >= 2);
  const decisions = governor.decisions();
  assert.ok(decisions.some((decision) => decision.reconfiguration?.evictedDomains.includes("imports")));
  assert.ok(decisions.some((decision) => decision.reconfiguration?.addedDomains.includes("metadata")));
});

test("10 KB budget preserves truth while preventing the two-domain pair from both staying resident", () => {
  const state = buildWorkspaceState({ fileCount: 2500, packageCount: 25 });
  const governor = new AdaptiveTruthCheckpointGovernor({ state, maxCheckpointBytes: 10_000, valueWindow: 4 });
  for (let i = 0; i < 4; i += 1) applyLateImport(governor, i);
  const summary = governor.summary();
  assert.equal(summary.maxDomains, 1);
  assert.equal(summary.selectedDomains.length, 1);
  assert.equal(summary.persistentCheckpointBytes, 10_000);
  validateDomainCheckpointedWorkspaceTruth(governor.tracked, {
    verifyHash: true,
    verifyCanonicalSize: true,
    verifyDomainIdentity: true,
    verifyDomainCheckpoints: true,
  });
});
