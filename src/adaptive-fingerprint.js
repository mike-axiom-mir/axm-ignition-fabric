import { hashValueMonolithic } from "./canonical-fingerprint-primitives.js";
import { hashValueStreaming } from "./streaming-fingerprint.js";

export const DEFAULT_ADAPTIVE_FINGERPRINT_THRESHOLD = 65536;

function primitiveLowerBound(value) {
  if (value === null) return 4;
  switch (typeof value) {
    case "string": return value.length + 2;
    case "boolean": return value ? 4 : 5;
    case "number": return 1;
    case "undefined":
    case "function":
    case "symbol": return 0;
    case "bigint": return 1;
    default: return 0;
  }
}

export function estimateCanonicalLowerBoundCapped(value, { thresholdCharacters = DEFAULT_ADAPTIVE_FINGERPRINT_THRESHOLD } = {}) {
  if (!Number.isSafeInteger(thresholdCharacters) || thresholdCharacters < 0) {
    throw new Error("thresholdCharacters must be a non-negative safe integer");
  }

  let lowerBoundCharacters = 0;
  let nodesVisited = 0;
  let stringsVisited = 0;
  let complete = true;

  function add(count) {
    lowerBoundCharacters += count;
    if (lowerBoundCharacters > thresholdCharacters) {
      complete = false;
      return true;
    }
    return false;
  }

  function visit(current, context = "value") {
    nodesVisited += 1;

    if (current === null || typeof current !== "object") {
      if (typeof current === "string") stringsVisited += 1;
      const bound = primitiveLowerBound(current);
      if ((context === "object-value") && ["undefined", "function", "symbol"].includes(typeof current)) {
        return add(9);
      }
      return add(bound);
    }

    if (Array.isArray(current)) {
      if (add(2 + Math.max(0, current.length - 1))) return true;
      for (let i = 0; i < current.length; i += 1) {
        if (!(i in current)) continue;
        if (visit(current[i], "array-value")) return true;
      }
      return false;
    }

    const keys = Object.keys(current);
    if (add(2 + Math.max(0, keys.length - 1))) return true;
    for (const key of keys) {
      stringsVisited += 1;
      if (add(key.length + 3)) return true;
      if (visit(current[key], "object-value")) return true;
    }
    return false;
  }

  visit(value);
  return Object.freeze({
    thresholdCharacters,
    lowerBoundCharacters,
    exceedsThreshold: lowerBoundCharacters > thresholdCharacters,
    complete,
    nodesVisited,
    stringsVisited,
  });
}

export function selectAdaptiveFingerprintMode(value, options = {}) {
  const estimate = estimateCanonicalLowerBoundCapped(value, options);
  return Object.freeze({
    mode: estimate.exceedsThreshold ? "streaming" : "monolithic",
    estimate,
  });
}

export function hashValueAdaptiveWithDecision(value, options = {}) {
  const decision = selectAdaptiveFingerprintMode(value, options);
  const hash = decision.mode === "streaming"
    ? hashValueStreaming(value)
    : hashValueMonolithic(value);
  return Object.freeze({ hash, ...decision });
}

export function hashValueAdaptive(value, options = {}) {
  return hashValueAdaptiveWithDecision(value, options).hash;
}
