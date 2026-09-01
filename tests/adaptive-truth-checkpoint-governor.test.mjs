import test from "node:test";
import assert from "node:assert/strict";

import {
  AdaptiveTruthCheckpointGovernor,
  replaceDomainCheckpointSelection,
} from "../src/adaptive-truth-checkpoint-governor.js";
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
      evidence: { test: "v0.23-early-metadata", i },
    });
  }
}

function applyLateImport(governor, iteration) {
  const even = iteration % 2 === 0;
  return governor.applyPointPatch({
    fileId: 2499,
    patch: importTogglePatch(governor.tracked.state, 2499, even ? 0 : 1, even ? 1 : 0),
    evidence: { test: "v0.23-late-import", iteration },
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
  assert.equal(second.decision.reconfiguration.bytesBuilt, 20_000);
  assert.equal(second.decision.reconfiguration.bytesRetained, 0);

  const third = applyLateImport(governor, 2);
  assert.deepEqual(third.tracked.lastMutation.domainAdvance.checkpointedChangedDomains, ["content-hash", "imports"]);
  assert.equal(third.tracked.lastMutation.domainAdvance.totalDomainEntriesRehashed, 2);
  assert.equal(third.tracked.lastMutation.domainAdvance.totalDomainEntriesSkipped, 4998);
  assert.ok(third.tracked.lastMutation.domainAdvance.totalDomainCanonicalCharactersRehashed < 100);
});

test("selection migration reuses surviving checkpoint arrays and builds only admissions", () => {
  const state = buildWorkspaceState({ fileCount: 2500, packageCount: 25 });
  const initial = bootstrapDomainCheckpointedWorkspaceTruth(state, { checkpointDomains: [] });

  const pair = replaceDomainCheckpointSelection(initial, ["content-hash", "imports"]);
  assert.equal(pair.metrics.mode, "checkpoint-selection-migration");
  assert.deepEqual(pair.metrics.addedDomains, ["content-hash", "imports"]);
  assert.deepEqual(pair.metrics.retainedDomains, []);
  assert.equal(pair.metrics.bytesBuilt, 20_000);
  assert.equal(pair.metrics.bytesEvicted, 0);

  const pairStorage = pair.tracked.domainHashCheckpoints;
  const shifted = replaceDomainCheckpointSelection(pair.tracked, ["imports", "metadata"]);
  assert.deepEqual(shifted.metrics.addedDomains, ["metadata"]);
  assert.deepEqual(shifted.metrics.retainedDomains, ["imports"]);
  assert.deepEqual(shifted.metrics.evictedDomains, ["content-hash"]);
  assert.equal(shifted.metrics.bytesBuilt, 10_000);
  assert.equal(shifted.metrics.bytesEvicted, 10_000);
  assert.equal(shifted.metrics.bytesRetained, 10_000);
  assert.equal(shifted.metrics.rebuildsRetainedDomains, false);
  assert.equal(shifted.metrics.retainedCheckpointArraysReused, true);
  assert.equal(
    shifted.tracked.domainHashCheckpoints.sharesDomainCheckpointStorage(pairStorage, "imports"),
    true,
  );
  assert.deepEqual(Object.keys(shifted.metrics.buildCanonicalCharactersByDomain), ["metadata"]);

  const shiftedStorage = shifted.tracked.domainHashCheckpoints;
  const evicted = replaceDomainCheckpointSelection(shifted.tracked, ["metadata"]);
  assert.deepEqual(evicted.metrics.addedDomains, []);
  assert.deepEqual(evicted.metrics.retainedDomains, ["metadata"]);
  assert.deepEqual(evicted.metrics.evictedDomains, ["imports"]);
  assert.equal(evicted.metrics.bytesBuilt, 0);
  assert.equal(evicted.metrics.buildCanonicalCharacters, 0);
  assert.equal(evicted.metrics.bytesEvicted, 10_000);
  assert.equal(evicted.metrics.bytesRetained, 10_000);
  assert.equal(evicted.metrics.retainedCheckpointArraysReused, true);
  assert.equal(
    evicted.tracked.domainHashCheckpoints.sharesDomainCheckpointStorage(shiftedStorage, "metadata"),
    true,
  );
  assert.equal(evicted.tracked.domainHashCheckpoints.generation, initial.domainHashCheckpoints.generation);
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

test("phase-shift decisions stay fixed while cumulative construction falls to 30 KB", () => {
  const state = buildWorkspaceState({ fileCount: 2500, packageCount: 25 });
  const governor = new AdaptiveTruthCheckpointGovernor({ state, maxCheckpointBytes: 20_000, valueWindow: 4 });
  for (let i = 0; i < 4; i += 1) applyLateImport(governor, i);

  for (let i = 0; i < 5; i += 1) {
    governor.applyPointPatch({
      fileId: 2499,
      patch: pathPatch(governor.tracked.state, 2499, `-late-metadata-${i}`),
      evidence: { test: "v0.23-phase-shift", i },
    });
  }

  const summary = governor.summary();
  assert.deepEqual(summary.selectedDomains, ["metadata"]);
  assert.equal(summary.persistentCheckpointBytes, 10_000);
  assert.equal(summary.totalCheckpointBytesBuilt, 30_000);
  assert.equal(summary.totalCheckpointBytesEvicted, 20_000);
  assert.equal(summary.totalCheckpointBytesRetainedAcrossMigrations, 20_000);
  assert.equal(summary.reconfigurationCount, 3);
  assert.equal(summary.totalDomainCanonicalCharactersRehashed, 496_836);
  assert.ok(summary.totalCheckpointBuildCanonicalCharacters < 446_008);
  assert.equal(summary.stats["content-hash"].buildCount, 1);
  assert.equal(summary.stats.imports.buildCount, 1);
  assert.equal(summary.stats.metadata.buildCount, 1);

  const migrations = governor.decisions()
    .filter((decision) => decision.reconfiguration)
    .map((decision) => ({
      generation: decision.generation,
      before: [...decision.selectedBefore],
      after: [...decision.selectedAfter],
      added: [...decision.reconfiguration.addedDomains],
      retained: [...decision.reconfiguration.retainedDomains],
      evicted: [...decision.reconfiguration.evictedDomains],
      bytesBuilt: decision.reconfiguration.bytesBuilt,
      reused: decision.reconfiguration.retainedCheckpointArraysReused,
    }));
  assert.deepEqual(migrations, [
    {
      generation: 2,
      before: [],
      after: ["content-hash", "imports"],
      added: ["content-hash", "imports"],
      retained: [],
      evicted: [],
      bytesBuilt: 20_000,
      reused: true,
    },
    {
      generation: 6,
      before: ["content-hash", "imports"],
      after: ["imports", "metadata"],
      added: ["metadata"],
      retained: ["imports"],
      evicted: ["content-hash"],
      bytesBuilt: 10_000,
      reused: true,
    },
    {
      generation: 8,
      before: ["imports", "metadata"],
      after: ["metadata"],
      added: [],
      retained: ["metadata"],
      evicted: ["imports"],
      bytesBuilt: 0,
      reused: true,
    },
  ]);

  validateDomainCheckpointedWorkspaceTruth(governor.tracked, {
    verifyHash: true,
    verifyCanonicalSize: true,
    verifyDomainIdentity: true,
    verifyDomainCheckpoints: true,
  });
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
