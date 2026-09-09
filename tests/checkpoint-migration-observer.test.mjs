import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { clampStep, projectIgnitionEvidence, validateIgnitionEvidence } from '../observer/checkpoint-migration-model.mjs';

const receiptUrl = new URL('../evidence/ignition-v0.23-retained-checkpoint-migration.json', import.meta.url);

async function committedReceipt() {
  return JSON.parse(await readFile(receiptUrl, 'utf8'));
}

test('projects the committed sealed migration into a truthful three-step human view', async () => {
  const receipt = await committedReceipt();
  const before = JSON.stringify(receipt);
  const view = projectIgnitionEvidence(receipt);
  assert.equal(view.steps.length, 3);
  assert.deepEqual(view.steps[1].retainedDomains, ['imports']);
  assert.deepEqual(view.steps[2].evictedDomains, ['imports']);
  assert.equal(view.steps[2].bytesBuilt, 0);
  assert.equal(view.steps[1].residentBytes, 20000);
  assert.equal(view.headline.bytesReductionPercent, 40);
  assert.equal(view.headline.workReductionPercent, 44.36);
  assert.equal(view.headline.maxResidentBytes, 20000);
  assert.equal(view.headline.exactReplayPreserved, true);
  assert.equal(JSON.stringify(receipt), before, 'projection must not mutate evidence');
});

test('fails closed on unsupported or structurally ambiguous evidence', async () => {
  const wrong = await committedReceipt();
  wrong.schema = 'axm.ignition-evidence/v0.22';
  assert.throws(() => validateIgnitionEvidence(wrong), /unsupported evidence schema/);

  const mismatch = await committedReceipt();
  mismatch.phaseShift.migrationConstruction.pop();
  assert.throws(() => validateIgnitionEvidence(mismatch), /equal-length/);

  const negative = await committedReceipt();
  negative.phaseShift.migrationConstruction[0].bytesBuilt = -1;
  assert.throws(() => validateIgnitionEvidence(negative), /finite non-negative number/);
});

test('keyboard step routing clamps to the available evidence timeline', () => {
  assert.equal(clampStep(-1, 3), 0);
  assert.equal(clampStep(1, 3), 1);
  assert.equal(clampStep(99, 3), 2);
  assert.equal(clampStep(Number.NaN, 3), 0);
});
