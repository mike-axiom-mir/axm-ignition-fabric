import test from "node:test";
import assert from "node:assert/strict";

import {
  AdaptiveTruthCheckpointGovernor,
  ADAPTIVE_TRUTH_CHECKPOINT_CONTINUATION_SCHEMA,
} from "../src/adaptive-truth-checkpoint-governor.js";
import { buildWorkspaceState } from "../src/realistic-workload.js";

function importTogglePatch(state, fileId, fromTarget, toTarget) {
  const file = state.files.find((entry) => entry.id === fileId);
  assert.ok(file);
  const needle = `file-${fromTarget}.js`;
  const replacement = `file-${toTarget}.js`;
  assert.equal(needle.length, replacement.length);
  assert.ok(file.content.includes(needle));
  return { content: file.content.replace(needle, replacement) };
}

function applyLateImport(governor, iteration) {
  const even = iteration % 2 === 0;
  return governor.applyPointPatch({
    fileId: 2499,
    patch: importTogglePatch(governor.tracked.state, 2499, even ? 0 : 1, even ? 1 : 0),
    evidence: { test: "restartable-adaptive-policy", iteration },
  });
}

function preparedGovernor() {
  const state = buildWorkspaceState({ fileCount: 2500, packageCount: 25 });
  const governor = new AdaptiveTruthCheckpointGovernor({
    state,
    maxCheckpointBytes: 20_000,
    valueWindow: 4,
  });
  applyLateImport(governor, 0);
  applyLateImport(governor, 1);
  assert.deepEqual(governor.summary().selectedDomains, ["content-hash", "imports"]);
  return governor;
}

test("explicit continuation preserves adaptive policy state that a cold restart loses", () => {
  const governor = preparedGovernor();
  const continuation = governor.checkpoint();
  assert.equal(continuation.schema, ADAPTIVE_TRUTH_CHECKPOINT_CONTINUATION_SCHEMA);
  assert.match(continuation.continuationSha256, /^[0-9a-f]{64}$/);

  const cold = new AdaptiveTruthCheckpointGovernor({
    state: governor.tracked.state,
    maxCheckpointBytes: 20_000,
    valueWindow: 4,
  });
  assert.equal(cold.generation, 0);
  assert.deepEqual(cold.summary().selectedDomains, []);
  assert.equal(cold.stats().imports.mutationCount, 0);

  const resumed = AdaptiveTruthCheckpointGovernor.restore({
    state: governor.tracked.state,
    continuation: JSON.parse(JSON.stringify(continuation)),
  });
  assert.equal(resumed.generation, governor.generation);
  assert.deepEqual(resumed.summary().selectedDomains, ["content-hash", "imports"]);
  assert.deepEqual(
    resumed.stats().imports.recentOpportunityCharacters,
    governor.stats().imports.recentOpportunityCharacters,
  );
  assert.equal(resumed.stats().imports.mutationCount, governor.stats().imports.mutationCount);
  assert.deepEqual(resumed.decisions(), []);

  const receipt = resumed.resumeReceipt();
  assert.equal(receipt.generation, 2);
  assert.equal(receipt.stateHash, governor.tracked.stateHash);
  assert.deepEqual(receipt.selectedDomains, ["content-hash", "imports"]);
  assert.equal(receipt.checkpointBytesRebuilt, 20_000);
  assert.ok(receipt.checkpointBuildCanonicalCharacters > 0);
  assert.equal(receipt.priorDecisionHistoryRetained, false);
});

test("resumed policy makes the same future decisions while charging restart reconstruction", () => {
  const uninterrupted = preparedGovernor();
  const resumed = AdaptiveTruthCheckpointGovernor.restore({
    state: uninterrupted.tracked.state,
    continuation: JSON.parse(JSON.stringify(uninterrupted.checkpoint())),
  });

  for (let iteration = 2; iteration < 4; iteration += 1) {
    const left = applyLateImport(uninterrupted, iteration);
    const right = applyLateImport(resumed, iteration);
    assert.deepEqual(right.decision, left.decision);
    assert.equal(right.tracked.stateHash, left.tracked.stateHash);
  }

  assert.deepEqual(resumed.summary().selectedDomains, uninterrupted.summary().selectedDomains);
  assert.deepEqual(
    resumed.stats().imports.recentOpportunityCharacters,
    uninterrupted.stats().imports.recentOpportunityCharacters,
  );
  assert.equal(
    resumed.totalDomainCanonicalCharactersRehashed,
    uninterrupted.totalDomainCanonicalCharactersRehashed,
  );
  assert.equal(
    resumed.totalCheckpointBytesBuilt,
    uninterrupted.totalCheckpointBytesBuilt + resumed.resumeReceipt().checkpointBytesRebuilt,
  );
  assert.equal(
    resumed.totalCheckpointBuildCanonicalCharacters,
    uninterrupted.totalCheckpointBuildCanonicalCharacters
      + resumed.resumeReceipt().checkpointBuildCanonicalCharacters,
  );
});

test("continuation JSON omits derived checkpoint arrays and prior decision history", () => {
  const governor = preparedGovernor();
  const encoded = JSON.stringify(governor.checkpoint());
  assert.equal(encoded.includes("domainHashCheckpoints"), false);
  assert.equal(encoded.includes("decisionHistory"), false);
  assert.equal(encoded.includes("Uint32Array"), false);

  const resumed = AdaptiveTruthCheckpointGovernor.restore({
    state: governor.tracked.state,
    continuation: JSON.parse(encoded),
  });
  assert.deepEqual(resumed.summary().selectedDomains, governor.summary().selectedDomains);
});

test("continuation tampering fails closed before restore", () => {
  const governor = preparedGovernor();
  const continuation = JSON.parse(JSON.stringify(governor.checkpoint()));
  continuation.generation += 1;

  assert.throws(
    () => AdaptiveTruthCheckpointGovernor.restore({ state: governor.tracked.state, continuation }),
    /continuation SHA-256 mismatch/,
  );
});

test("a valid continuation cannot resume against different canonical state", () => {
  const governor = preparedGovernor();
  const continuation = JSON.parse(JSON.stringify(governor.checkpoint()));
  const driftedState = structuredClone(governor.tracked.state);
  driftedState.files[0].path = `${driftedState.files[0].path}-drift`;

  assert.throws(
    () => AdaptiveTruthCheckpointGovernor.restore({ state: driftedState, continuation }),
    /does not match canonical state/,
  );
});
