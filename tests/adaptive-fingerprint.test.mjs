import test from "node:test";
import assert from "node:assert/strict";
import { hashValue, hashValueMonolithic } from "../src/ignition-core.js";
import {
  DEFAULT_ADAPTIVE_FINGERPRINT_THRESHOLD,
  estimateCanonicalLowerBoundCapped,
  hashValueAdaptiveWithDecision,
  selectAdaptiveFingerprintMode,
} from "../src/adaptive-fingerprint.js";
import { buildWorkspaceState } from "../src/realistic-workload.js";

test("adaptive fingerprint preserves exact monolithic hashes on representative values", () => {
  const sparse = [];
  sparse.length = 4;
  sparse[1] = undefined;
  sparse[3] = "tail";
  const values = [
    null,
    true,
    false,
    0,
    -0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "plain",
    "quote\"slash\\line\n",
    "é漢😀\ud800\udc00",
    [],
    [1, "two", null, false],
    sparse,
    { z: 1, a: 2, nested: { c: 3, b: [4, 5] } },
    { undefinedValue: undefined, functionValue() {}, symbolValue: Symbol("x") },
    new Date("2020-01-01T00:00:00.000Z"),
  ];

  for (const value of values) {
    assert.equal(hashValue(value), hashValueMonolithic(value));
    assert.equal(hashValueAdaptiveWithDecision(value).hash, hashValueMonolithic(value));
  }
});

test("tiny canonical values choose monolithic without constructing a selection string", () => {
  const value = { a: 1, b: "small", c: [true, null] };
  const decision = selectAdaptiveFingerprintMode(value);
  assert.equal(decision.mode, "monolithic");
  assert.equal(decision.estimate.complete, true);
  assert.equal(decision.estimate.exceedsThreshold, false);
  assert.ok(decision.estimate.lowerBoundCharacters < DEFAULT_ADAPTIVE_FINGERPRINT_THRESHOLD);
  assert.equal(hashValue(value), hashValueMonolithic(value));
});

test("2,500-file canonical state chooses streaming from a capped structural lower bound", () => {
  const state = buildWorkspaceState({ fileCount: 2500 });
  const decision = hashValueAdaptiveWithDecision(state);
  assert.equal(decision.mode, "streaming");
  assert.equal(decision.estimate.complete, false);
  assert.equal(decision.estimate.exceedsThreshold, true);
  assert.ok(decision.estimate.lowerBoundCharacters > DEFAULT_ADAPTIVE_FINGERPRINT_THRESHOLD);
  assert.ok(decision.estimate.nodesVisited < 2500 * 10);
  assert.equal(decision.hash, hashValueMonolithic(state));
  assert.equal(hashValue(state), decision.hash);
});

test("large primitive string crosses the policy without serializing a whole object graph", () => {
  const value = "x".repeat(DEFAULT_ADAPTIVE_FINGERPRINT_THRESHOLD + 1);
  const estimate = estimateCanonicalLowerBoundCapped(value);
  assert.equal(estimate.exceedsThreshold, true);
  assert.equal(estimate.complete, false);
  assert.equal(estimate.nodesVisited, 1);
  assert.equal(hashValue(value), hashValueMonolithic(value));
});

test("adaptive mode is insertion-order independent for equivalent object content", () => {
  const payload = "x".repeat(40000);
  const left = { z: payload, a: payload };
  const right = { a: payload, z: payload };
  const leftDecision = hashValueAdaptiveWithDecision(left);
  const rightDecision = hashValueAdaptiveWithDecision(right);
  assert.equal(leftDecision.mode, "streaming");
  assert.equal(rightDecision.mode, "streaming");
  assert.equal(leftDecision.hash, rightDecision.hash);
  assert.equal(leftDecision.hash, hashValueMonolithic(left));
});

test("adaptive threshold is explicit and unsupported top-level values still reject", () => {
  const value = { text: "x".repeat(100) };
  assert.equal(selectAdaptiveFingerprintMode(value, { thresholdCharacters: 1000 }).mode, "monolithic");
  assert.equal(selectAdaptiveFingerprintMode(value, { thresholdCharacters: 10 }).mode, "streaming");
  assert.throws(() => selectAdaptiveFingerprintMode(value, { thresholdCharacters: -1 }), /thresholdCharacters/);
  assert.throws(() => hashValue(undefined), TypeError);
  assert.throws(() => hashValue(1n), TypeError);
});
