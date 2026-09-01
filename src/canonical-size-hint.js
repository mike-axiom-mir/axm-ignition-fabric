import { hashValueMonolithic } from "./canonical-fingerprint-primitives.js";
import { DEFAULT_ADAPTIVE_FINGERPRINT_THRESHOLD } from "./adaptive-fingerprint.js";
import { hashValueStreaming } from "./streaming-fingerprint.js";

export const WORKSPACE_CANONICAL_SIZE_HINT_SCHEMA = "axm.ignition-workspace-canonical-size-hint/v0.19";

function jsonStringCharacterLength(value) {
  const text = String(value);
  let length = 2;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x0c || code === 0x0a || code === 0x0d || code === 0x09) {
      length += 2;
      continue;
    }
    if (code <= 0x1f) {
      length += 6;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 2;
        i += 1;
      } else {
        length += 6;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      length += 6;
      continue;
    }
    length += 1;
  }
  return length;
}

function primitiveCanonicalLength(value, context) {
  if (value === null) return 4;
  const type = typeof value;
  if (type === "string") return jsonStringCharacterLength(value);
  if (type === "boolean") return value ? 4 : 5;
  if (type === "number") return JSON.stringify(value).length;
  if (type === "bigint") {
    JSON.stringify(value);
  }
  if (type === "undefined" || type === "function" || type === "symbol") {
    if (context === "object-value") return 9;
    if (context === "array-value") return 0;
    throw new Error("unsupported top-level canonical value");
  }
  throw new Error(`unsupported canonical primitive: ${type}`);
}

export function canonicalStringCharacterLength(value, context = "top-level") {
  if (value === null || typeof value !== "object") return primitiveCanonicalLength(value, context);

  if (Array.isArray(value)) {
    let length = 2 + Math.max(0, value.length - 1);
    for (let i = 0; i < value.length; i += 1) {
      if (!(i in value)) continue;
      length += canonicalStringCharacterLength(value[i], "array-value");
    }
    return length;
  }

  const keys = Object.keys(value).sort();
  let length = 2 + Math.max(0, keys.length - 1);
  for (const key of keys) {
    length += jsonStringCharacterLength(key) + 1;
    length += canonicalStringCharacterLength(value[key], "object-value");
  }
  return length;
}

function hintBody({ stateHash, fileCount, canonicalCharacters, generation, source, previousReceiptHash = null, transition = null }) {
  return {
    schema: WORKSPACE_CANONICAL_SIZE_HINT_SCHEMA,
    stateHash,
    fileCount,
    canonicalCharacters,
    generation,
    source,
    previousReceiptHash,
    transition,
  };
}

function freezeHint(body) {
  return Object.freeze({ ...body, receiptHash: hashValueMonolithic(body) });
}

export function validateWorkspaceCanonicalSizeHint(hint, { expectedStateHash = null, expectedFileCount = null } = {}) {
  if (!hint || hint.schema !== WORKSPACE_CANONICAL_SIZE_HINT_SCHEMA) throw new Error("invalid workspace canonical size hint schema");
  if (typeof hint.stateHash !== "string" || !hint.stateHash) throw new Error("workspace canonical size hint stateHash required");
  if (!Number.isSafeInteger(hint.fileCount) || hint.fileCount < 0) throw new Error("invalid workspace canonical size hint fileCount");
  if (!Number.isSafeInteger(hint.canonicalCharacters) || hint.canonicalCharacters < 0) throw new Error("invalid workspace canonical size hint canonicalCharacters");
  if (!Number.isSafeInteger(hint.generation) || hint.generation < 0) throw new Error("invalid workspace canonical size hint generation");
  if (expectedStateHash && hint.stateHash !== expectedStateHash) throw new Error("workspace canonical size hint stateHash mismatch");
  if (expectedFileCount !== null && hint.fileCount !== expectedFileCount) throw new Error("workspace canonical size hint fileCount mismatch");
  const body = hintBody(hint);
  if (hashValueMonolithic(body) !== hint.receiptHash) throw new Error("workspace canonical size hint receiptHash mismatch");
  return true;
}

export function buildWorkspaceCanonicalSizeHint(state, { stateHash } = {}) {
  if (!state || !Array.isArray(state.files)) throw new Error("workspace state requires files array");
  if (typeof stateHash !== "string" || !stateHash) throw new Error("workspace canonical size bootstrap requires stateHash");
  return freezeHint(hintBody({
    stateHash,
    fileCount: state.files.length,
    canonicalCharacters: canonicalStringCharacterLength(state),
    generation: 0,
    source: "full-canonical-length-scan",
  }));
}

export function deriveWorkspacePointCanonicalCharacters({ hint, beforeState, afterState, fileIndex }) {
  validateWorkspaceCanonicalSizeHint(hint, { expectedFileCount: beforeState?.files?.length ?? null });
  if (!beforeState || !afterState || !Array.isArray(beforeState.files) || !Array.isArray(afterState.files)) {
    throw new Error("workspace canonical size transition requires before/after files arrays");
  }
  if (beforeState.files.length !== afterState.files.length || beforeState.files.length !== hint.fileCount) {
    throw new Error("workspace canonical size point transition cannot change file count");
  }
  if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= hint.fileCount) throw new Error("workspace canonical size fileIndex out of range");
  const beforeFile = beforeState.files[fileIndex];
  const afterFile = afterState.files[fileIndex];
  if (!beforeFile || !afterFile || beforeFile.id !== afterFile.id) throw new Error("workspace canonical size point transition cannot replace file identity");
  const beforeFileCharacters = canonicalStringCharacterLength(beforeFile);
  const afterFileCharacters = canonicalStringCharacterLength(afterFile);
  const deltaCharacters = afterFileCharacters - beforeFileCharacters;
  return Object.freeze({
    canonicalCharacters: hint.canonicalCharacters + deltaCharacters,
    beforeFileCharacters,
    afterFileCharacters,
    deltaCharacters,
  });
}

export function hashValueWithCanonicalSizeHint(value, canonicalCharacters, { thresholdCharacters = DEFAULT_ADAPTIVE_FINGERPRINT_THRESHOLD } = {}) {
  if (!Number.isSafeInteger(canonicalCharacters) || canonicalCharacters < 0) throw new Error("canonicalCharacters must be a non-negative safe integer");
  if (!Number.isSafeInteger(thresholdCharacters) || thresholdCharacters < 0) throw new Error("thresholdCharacters must be a non-negative safe integer");
  const mode = canonicalCharacters > thresholdCharacters ? "streaming" : "monolithic";
  const hash = mode === "streaming" ? hashValueStreaming(value) : hashValueMonolithic(value);
  return Object.freeze({
    hash,
    mode,
    canonicalCharacters,
    thresholdCharacters,
    decisionSource: "maintained-exact-canonical-size",
    preflightNodesVisited: 0,
  });
}

export function advanceWorkspaceCanonicalSizeHint({ hint, beforeState, afterState, fileIndex, toStateHash }) {
  validateWorkspaceCanonicalSizeHint(hint, { expectedFileCount: beforeState?.files?.length ?? null });
  if (typeof toStateHash !== "string" || !toStateHash) throw new Error("workspace canonical size transition toStateHash required");
  const derived = deriveWorkspacePointCanonicalCharacters({ hint, beforeState, afterState, fileIndex });
  return freezeHint(hintBody({
    stateHash: toStateHash,
    fileCount: hint.fileCount,
    canonicalCharacters: derived.canonicalCharacters,
    generation: hint.generation + 1,
    source: "point-mutation-maintained",
    previousReceiptHash: hint.receiptHash,
    transition: {
      fileIndex,
      fileId: beforeState.files[fileIndex].id,
      beforeFileCharacters: derived.beforeFileCharacters,
      afterFileCharacters: derived.afterFileCharacters,
      deltaCharacters: derived.deltaCharacters,
    },
  }));
}
