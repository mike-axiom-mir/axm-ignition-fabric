import test from "node:test";
import assert from "node:assert/strict";
import { fnv1a32, hashValueMonolithic, stableStringify } from "../src/ignition-core.js";
import {
  forEachStableStringChunk,
  hashValueStreaming,
  hashValueStreamingWithMetrics,
} from "../src/streaming-fingerprint.js";
import { buildWorkspaceState } from "../src/realistic-workload.js";

function streamedText(value) {
  const chunks = [];
  forEachStableStringChunk(value, (chunk) => chunks.push(chunk));
  return chunks.join("");
}

test("streamed canonical characters exactly equal stableStringify for representative values", () => {
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
    1.5,
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
    assert.equal(streamedText(value), stableStringify(value));
    assert.equal(hashValueStreaming(value), hashValueMonolithic(value));
  }
});

test("streaming fingerprint preserves sorted object-key semantics independent of insertion order", () => {
  const left = { z: 3, a: 1, m: { y: 2, b: 1 } };
  const right = { m: { b: 1, y: 2 }, a: 1, z: 3 };
  assert.equal(stableStringify(left), stableStringify(right));
  assert.equal(hashValueStreaming(left), hashValueStreaming(right));
  assert.equal(hashValueStreaming(left), hashValueMonolithic(left));
});

test("streaming FNV feeds the same UTF-16 code units as the monolithic FNV", () => {
  const value = { emoji: "😀", escaped: "\ud800", text: "Aé漢Z" };
  const text = stableStringify(value);
  const streamed = hashValueStreamingWithMetrics(value);
  assert.equal(streamed.hash, fnv1a32(text));
  assert.equal(streamed.metrics.characterCount, text.length);
  assert.ok(streamed.metrics.chunkCount > 1);
  assert.ok(streamed.metrics.maxChunkCharacters < text.length);
});

test("2,500-file canonical workspace fingerprint is exactly unchanged", () => {
  const state = buildWorkspaceState({ fileCount: 2500 });
  const streamed = hashValueStreamingWithMetrics(state);
  assert.equal(streamed.hash, hashValueMonolithic(state));
  assert.equal(streamed.metrics.characterCount, stableStringify(state).length);
  assert.ok(streamed.metrics.maxChunkCharacters < streamed.metrics.characterCount / 100);
});

test("unsupported top-level values still reject rather than inventing a canonical hash", () => {
  assert.throws(() => hashValueMonolithic(undefined), TypeError);
  assert.throws(() => hashValueStreaming(undefined), TypeError);
  assert.throws(() => hashValueMonolithic(1n), TypeError);
  assert.throws(() => hashValueStreaming(1n), TypeError);
});
