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

function observe(phaseProbe, phase, details) {
  if (!phaseProbe) return;
  phaseProbe(Object.freeze({ phase, ...details }));
}

export function hashValueSharedTraversalWithDecision(
  value,
  {
    thresholdCharacters = DEFAULT_SHARED_TRAVERSAL_THRESHOLD,
    phaseProbe = null,
  } = {},
) {
  validateThreshold(thresholdCharacters);
  if (phaseProbe !== null && typeof phaseProbe !== "function") {
    throw new Error("phaseProbe must be a function or null");
  }

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
      observe(phaseProbe, "threshold-crossed-prefix-live", {
        canonicalCharacterCount,
        bufferedPrefixCharacters: bufferedPrefix.length,
        switchChunkCharacters: text.length,
      });
      bufferedPrefix = "";
      accumulator.update(text);
      observe(phaseProbe, "threshold-crossed-prefix-released", {
        canonicalCharacterCount,
        bufferedPrefixCharacters: 0,
        switchChunkCharacters: text.length,
      });
      return;
    }

    bufferedPrefix += text;
  });

  if (!accumulator) {
    observe(phaseProbe, "small-canonical-buffer-complete", {
      canonicalCharacterCount,
      bufferedPrefixCharacters: bufferedPrefix.length,
      switchChunkCharacters: null,
    });
  } else {
    observe(phaseProbe, "streaming-traversal-complete", {
      canonicalCharacterCount,
      bufferedPrefixCharacters: 0,
      switchChunkCharacters,
    });
  }

  const hash = accumulator ? accumulator.digest() : fnv1a32(bufferedPrefix);
  const fnvMetrics = accumulator
    ? accumulator.metrics()
    : Object.freeze({
        characterCount: bufferedPrefix.length,
        chunkCount: 1,
        maxChunkCharacters: bufferedPrefix.length,
      });

  observe(phaseProbe, "hash-complete", {
    canonicalCharacterCount,
    bufferedPrefixCharacters: accumulator ? 0 : bufferedPrefix.length,
    switchChunkCharacters,
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
