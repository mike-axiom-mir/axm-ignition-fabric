import { stableStringify } from "./canonical-fingerprint-primitives.js";

const FNV1A32_OFFSET = 0x811c9dc5;
const FNV1A32_PRIME = 0x01000193;

export const WORKSPACE_FINGERPRINT_CHECKPOINT_SCHEMA = "axm.ignition-workspace-fingerprint-checkpoints/v0.20";

function advanceFNV(hash, text) {
  const value = String(text);
  let next = hash >>> 0;
  for (let i = 0; i < value.length; i += 1) {
    next ^= value.charCodeAt(i);
    next = Math.imul(next, FNV1A32_PRIME) >>> 0;
  }
  return next >>> 0;
}

function digestFNV(hash) {
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stablePart(value) {
  const serialized = stableStringify(value);
  return serialized === undefined ? "undefined" : String(serialized);
}

function workspaceEnvelope(state) {
  if (!state || !Array.isArray(state.files)) throw new Error("workspace state requires files array");
  const keys = Object.keys(state).sort();
  const filesPosition = keys.indexOf("files");
  if (filesPosition < 0) throw new Error("workspace canonical envelope requires files key");

  let prefix = "{";
  for (let i = 0; i < filesPosition; i += 1) {
    if (i > 0) prefix += ",";
    const key = keys[i];
    prefix += `${JSON.stringify(key)}:${stablePart(state[key])}`;
  }
  if (filesPosition > 0) prefix += ",";
  prefix += `${JSON.stringify("files")}:[`;

  let suffix = "]";
  for (let i = filesPosition + 1; i < keys.length; i += 1) {
    const key = keys[i];
    suffix += `,${JSON.stringify(key)}:${stablePart(state[key])}`;
  }
  suffix += "}";
  return { prefix, suffix, keys };
}

function assertDenseFiles(state) {
  for (let i = 0; i < state.files.length; i += 1) {
    if (!(i in state.files)) throw new Error("checkpointed workspace fingerprint requires dense files array");
    if (!state.files[i] || typeof state.files[i] !== "object") throw new Error("checkpointed workspace fingerprint requires file objects");
  }
}

export class WorkspaceFingerprintCheckpoints {
  #checkpoints;
  #prefix;
  #suffix;
  #topLevelKeys;

  constructor({ stateHash, fileCount, checkpoints, prefix, suffix, topLevelKeys, generation = 0, lastAdvance = null }) {
    if (typeof stateHash !== "string" || !stateHash) throw new Error("checkpoint index requires stateHash");
    if (!Number.isSafeInteger(fileCount) || fileCount < 0) throw new Error("checkpoint index requires valid fileCount");
    if (!(checkpoints instanceof Uint32Array) || checkpoints.length !== fileCount) throw new Error("checkpoint index requires Uint32Array checkpoints");
    this.schema = WORKSPACE_FINGERPRINT_CHECKPOINT_SCHEMA;
    this.stateHash = stateHash;
    this.fileCount = fileCount;
    this.generation = generation;
    this.checkpointBytes = checkpoints.byteLength;
    this.lastAdvance = lastAdvance ? Object.freeze({ ...lastAdvance }) : null;
    this.#checkpoints = checkpoints;
    this.#prefix = prefix;
    this.#suffix = suffix;
    this.#topLevelKeys = Object.freeze([...topLevelKeys]);
    Object.freeze(this);
  }

  checkpointAt(fileIndex) {
    if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= this.fileCount) throw new Error("checkpoint fileIndex out of range");
    return this.#checkpoints[fileIndex] >>> 0;
  }

  topLevelKeys() {
    return [...this.#topLevelKeys];
  }

  advancePointMutation({ beforeState, afterState, fileIndex }) {
    if (!beforeState || !afterState || !Array.isArray(beforeState.files) || !Array.isArray(afterState.files)) {
      throw new Error("checkpoint point mutation requires before/after files arrays");
    }
    if (beforeState.files.length !== this.fileCount || afterState.files.length !== this.fileCount) {
      throw new Error("checkpoint point mutation cannot change file count");
    }
    if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= this.fileCount) throw new Error("checkpoint fileIndex out of range");
    assertDenseFiles(afterState);
    const nextEnvelope = workspaceEnvelope(afterState);
    if (JSON.stringify(nextEnvelope.keys) !== JSON.stringify(this.#topLevelKeys)) throw new Error("checkpoint point mutation cannot change top-level key layout");
    if (nextEnvelope.prefix !== this.#prefix || nextEnvelope.suffix !== this.#suffix) {
      throw new Error("checkpoint point mutation cannot change non-file canonical envelope");
    }
    const beforeFile = beforeState.files[fileIndex];
    const afterFile = afterState.files[fileIndex];
    if (!beforeFile || !afterFile || beforeFile.id !== afterFile.id) throw new Error("checkpoint point mutation cannot replace file identity");

    const nextCheckpoints = new Uint32Array(this.fileCount);
    if (fileIndex >= 0) nextCheckpoints.set(this.#checkpoints.subarray(0, fileIndex + 1), 0);

    let hash = this.#checkpoints[fileIndex] >>> 0;
    let canonicalCharactersRehashed = 0;
    let filesRehashed = 0;

    const changedText = stablePart(afterFile);
    hash = advanceFNV(hash, changedText);
    canonicalCharactersRehashed += changedText.length;
    filesRehashed += 1;

    for (let i = fileIndex + 1; i < this.fileCount; i += 1) {
      hash = advanceFNV(hash, ",");
      canonicalCharactersRehashed += 1;
      nextCheckpoints[i] = hash >>> 0;
      const fileText = stablePart(afterState.files[i]);
      hash = advanceFNV(hash, fileText);
      canonicalCharactersRehashed += fileText.length;
      filesRehashed += 1;
    }

    hash = advanceFNV(hash, this.#suffix);
    canonicalCharactersRehashed += this.#suffix.length;
    const stateHash = digestFNV(hash);
    const lastAdvance = Object.freeze({
      mode: "point-checkpoint-suffix-rehash",
      fileIndex,
      fileId: beforeFile.id,
      filesRehashed,
      filesSkipped: fileIndex,
      canonicalCharactersRehashed,
      checkpointBytes: nextCheckpoints.byteLength,
      exactCompatibility: true,
      suffixStillRehashed: true,
    });

    return new WorkspaceFingerprintCheckpoints({
      stateHash,
      fileCount: this.fileCount,
      checkpoints: nextCheckpoints,
      prefix: this.#prefix,
      suffix: this.#suffix,
      topLevelKeys: this.#topLevelKeys,
      generation: this.generation + 1,
      lastAdvance,
    });
  }
}

export function buildWorkspaceFingerprintCheckpoints(state) {
  if (!state || !Array.isArray(state.files)) throw new Error("workspace state requires files array");
  assertDenseFiles(state);
  const { prefix, suffix, keys } = workspaceEnvelope(state);
  const checkpoints = new Uint32Array(state.files.length);
  let hash = advanceFNV(FNV1A32_OFFSET, prefix);
  let canonicalCharactersHashed = prefix.length;

  for (let i = 0; i < state.files.length; i += 1) {
    if (i > 0) {
      hash = advanceFNV(hash, ",");
      canonicalCharactersHashed += 1;
    }
    checkpoints[i] = hash >>> 0;
    const fileText = stablePart(state.files[i]);
    hash = advanceFNV(hash, fileText);
    canonicalCharactersHashed += fileText.length;
  }

  hash = advanceFNV(hash, suffix);
  canonicalCharactersHashed += suffix.length;
  return new WorkspaceFingerprintCheckpoints({
    stateHash: digestFNV(hash),
    fileCount: state.files.length,
    checkpoints,
    prefix,
    suffix,
    topLevelKeys: keys,
    generation: 0,
    lastAdvance: {
      mode: "full-checkpoint-bootstrap",
      filesRehashed: state.files.length,
      filesSkipped: 0,
      canonicalCharactersRehashed: canonicalCharactersHashed,
      checkpointBytes: checkpoints.byteLength,
      exactCompatibility: true,
      suffixStillRehashed: true,
    },
  });
}
