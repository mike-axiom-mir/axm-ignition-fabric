import { fnv1a32 } from "./canonical-fingerprint-primitives.js";
import { DEFAULT_ADAPTIVE_FINGERPRINT_THRESHOLD } from "./adaptive-fingerprint.js";
import {
  Fnv1a32Accumulator,
  forEachStableStringChunkWithMetrics,
} from "./streaming-fingerprint.js";

export const DEFAULT_SHARED_TRAVERSAL_THRESHOLD = DEFAULT_ADAPTIVE_FINGERPRINT_THRESHOLD;

function validateThreshold(thresholdCharacters) {
  if (!Number.isSafeInteger(thresholdCharacters) || thresholdCharacters < 0) {
    throw new Error("thresholdCharacters must be a non-negative safe integer");
  }
}

export function hashValueSharedTraversalWithDecision(
  value,
  { thresholdCharacters = DEFAULT_SHARED_TRAVERSAL_THRESHOLD } = {},
) {
  validateThreshold(thresholdCharacters);

  let bufferedPrefix = "";
  let accumulator = null;
  let mode = "monolithic";
  let canonicalCharacterCount = 0;
  let canonicalChunkCount = 0;
  let maxCanonicalChunkCharacters = 0;
  let switchAtCanonicalCharacter = null;
  let bufferedCharactersAtSwitch = null;
  let switchChunkCharacters = null;

  const traversal = forEachStableStringChunkWithMetrics(value, (chunk) => {
    const text = String(chunk);
    canonicalChunkCount += 1;
    canonicalCharacterCount += text.length;
    maxCanonicalChunkCharacters = Math.max(maxCanonicalChunkCharacters, text.length);

    if (accumulator) {
      accumulator.update(text);
      return;
    }

    if (bufferedPrefix.length + text.length > thresholdCharacters) {
      mode = "streaming";
      switchAtCanonicalCharacter = canonicalCharacterCount;
      bufferedCharactersAtSwitch = bufferedPrefix.length;
      switchChunkCharacters = text.length;
      accumulator = new Fnv1a32Accumulator();
      if (bufferedPrefix.length > 0) accumulator.update(bufferedPrefix);
      bufferedPrefix = "";
      accumulator.update(text);
      return;
    }

    bufferedPrefix += text;
  });

  const hash = accumulator ? accumulator.digest() : fnv1a32(bufferedPrefix);
  const fnvMetrics = accumulator
    ? accumulator.metrics()
    : Object.freeze({
        characterCount: bufferedPrefix.length,
        chunkCount: 1,
        maxChunkCharacters: bufferedPrefix.length,
      });

  return Object.freeze({
    hash,
    mode,
    thresholdCharacters,
    metrics: Object.freeze({
      ...traversal,
      canonicalCharacterCount,
      canonicalChunkCount,
      maxCanonicalChunkCharacters,
      switchAtCanonicalCharacter,
      bufferedCharactersAtSwitch,
      switchChunkCharacters,
      finalBufferedCharacters: bufferedPrefix.length,
      maxRetainedCanonicalPrefixCharacters: mode === "streaming"
        ? Math.max(bufferedCharactersAtSwitch ?? 0, switchChunkCharacters ?? 0)
        : bufferedPrefix.length,
      fnvFeedCharacterCount: fnvMetrics.characterCount,
      fnvFeedChunkCount: fnvMetrics.chunkCount,
      fnvFeedMaxChunkCharacters: fnvMetrics.maxChunkCharacters,
      objectTraversalRestarts: 0,
    }),
  });
}

export function hashValueSharedTraversal(value, options = {}) {
  return hashValueSharedTraversalWithDecision(value, options).hash;
}
