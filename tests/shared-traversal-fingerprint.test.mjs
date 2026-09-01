import test from "node:test";
import assert from "node:assert/strict";
import {
  hashValueMonolithic,
  stableStringify,
} from "../src/ignition-core.js";
import {
  DEFAULT_ADAPTIVE_FINGERPRINT_THRESHOLD,
  hashValueAdaptiveWithDecision,
} from "../src/adaptive-fingerprint.js";
import {
  hashValueStreamingWithMetrics,
} from "../src/streaming-fingerprint.js";
import {
  DEFAULT_SHARED_TRAVERSAL_THRESHOLD,
  hashValueSharedTraversal,
  hashValueSharedTraversalWithDecision,
} from "../src/shared-traversal-fingerprint.js";
import { buildWorkspaceState } from "../src/realistic-workload.js";

const tiny = { a: 1, b: "tiny", nested: [true, null, "x"], z: { q: 2 } };

test("shared traversal preserves exact monolithic hashes across representative values", () => {
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
    tiny,
    { z: 1, a: 2, nested: { c: 3, b: [4, 5] } },
    { undefinedValue: undefined, functionValue() {}, symbolValue: Symbol("x") },
    new Date("2020-01-01T00:00:00.000Z"),
  ];

  for (const value of values) {
    assert.equal(hashValueSharedTraversal(value), hashValueMonolithic(value));
  }
});

test("small composite value finishes one traversal then hashes its compact canonical buffer", () => {
  const result = hashValueSharedTraversalWithDecision(tiny);
  const text = stableStringify(tiny);
  const streamed = hashValueStreamingWithMetrics(tiny);
  const previous = hashValueAdaptiveWithDecision(tiny);

  assert.equal(result.mode, "monolithic");
  assert.equal(previous.mode, "monolithic");
  assert.equal(result.hash, hashValueMonolithic(tiny));
  assert.equal(result.metrics.traversalPasses, 1);
  assert.equal(result.metrics.objectTraversalRestarts, 0);
  assert.equal(result.metrics.canonicalCharacterCount, text.length);
  assert.equal(result.metrics.finalBufferedCharacters, text.length);
  assert.equal(result.metrics.nodesVisited, streamed.metrics.nodesVisited);
  assert.equal(previous.estimate.complete, true);
  assert.equal(previous.estimate.nodesVisited, result.metrics.nodesVisited);
});

test("large workspace crosses threshold in the same traversal and never restarts object walking", () => {
  const state = buildWorkspaceState({ fileCount: 2500 });
  const result = hashValueSharedTraversalWithDecision(state);
  const streamed = hashValueStreamingWithMetrics(state);
  const previous = hashValueAdaptiveWithDecision(state);

  assert.equal(DEFAULT_SHARED_TRAVERSAL_THRESHOLD, DEFAULT_ADAPTIVE_FINGERPRINT_THRESHOLD);
  assert.equal(result.mode, "streaming");
  assert.equal(previous.mode, "streaming");
  assert.equal(result.hash, hashValueMonolithic(state));
  assert.equal(result.hash, streamed.hash);
  assert.equal(result.metrics.traversalPasses, 1);
  assert.equal(result.metrics.objectTraversalRestarts, 0);
  assert.equal(result.metrics.nodesVisited, streamed.metrics.nodesVisited);
  assert.equal(result.metrics.canonicalCharacterCount, streamed.metrics.characterCount);
  assert.equal(result.metrics.fnvFeedCharacterCount, streamed.metrics.characterCount);
  assert.ok(result.metrics.bufferedCharactersAtSwitch <= DEFAULT_SHARED_TRAVERSAL_THRESHOLD);
  assert.ok(result.metrics.switchAtCanonicalCharacter > DEFAULT_SHARED_TRAVERSAL_THRESHOLD);
  assert.ok(previous.estimate.nodesVisited > 0);
  assert.ok(previous.estimate.nodesVisited < result.metrics.nodesVisited);
});

test("shared traversal keeps the measured 100-file/250-file route boundary", () => {
  const small = buildWorkspaceState({ fileCount: 100 });
  const large = buildWorkspaceState({ fileCount: 250 });

  const smallShared = hashValueSharedTraversalWithDecision(small);
  const largeShared = hashValueSharedTraversalWithDecision(large);
  const smallPrevious = hashValueAdaptiveWithDecision(small);
  const largePrevious = hashValueAdaptiveWithDecision(large);

  assert.equal(smallShared.mode, "monolithic");
  assert.equal(smallPrevious.mode, "monolithic");
  assert.equal(largeShared.mode, "streaming");
  assert.equal(largePrevious.mode, "streaming");
  assert.equal(smallShared.hash, hashValueMonolithic(small));
  assert.equal(largeShared.hash, hashValueMonolithic(large));
});

test("zero threshold forces streaming without changing truth", () => {
  const result = hashValueSharedTraversalWithDecision(tiny, { thresholdCharacters: 0 });
  assert.equal(result.mode, "streaming");
  assert.equal(result.hash, hashValueMonolithic(tiny));
  assert.equal(result.metrics.objectTraversalRestarts, 0);
});

test("one giant primitive string exposes the single-chunk boundary instead of pretending every stream is bounded", () => {
  const value = "x".repeat(DEFAULT_SHARED_TRAVERSAL_THRESHOLD * 2);
  const result = hashValueSharedTraversalWithDecision(value);

  assert.equal(result.mode, "streaming");
  assert.equal(result.hash, hashValueMonolithic(value));
  assert.ok(result.metrics.maxCanonicalChunkCharacters > DEFAULT_SHARED_TRAVERSAL_THRESHOLD);
  assert.equal(result.metrics.bufferedCharactersAtSwitch, 0);
  assert.equal(result.metrics.objectTraversalRestarts, 0);
});

test("shared traversal preserves rejection boundaries", () => {
  assert.throws(() => hashValueSharedTraversal(undefined), TypeError);
  assert.throws(() => hashValueSharedTraversal(1n), TypeError);
  assert.throws(
    () => hashValueSharedTraversal(tiny, { thresholdCharacters: -1 }),
    /thresholdCharacters/,
  );
});
