import { hashValue } from "./ignition-core.js";
import { createWorkspacePointMutationReceipt } from "./incremental-domain-index.js";
import {
  advanceWorkspaceCanonicalSizeHint,
  buildWorkspaceCanonicalSizeHint,
  deriveWorkspacePointCanonicalCharacters,
  hashValueWithCanonicalSizeHint,
  validateWorkspaceCanonicalSizeHint,
} from "./canonical-size-hint.js";

export const TRACKED_WORKSPACE_TRUTH_SCHEMA = "axm.ignition-tracked-workspace-truth/v0.19";

function validateTracked(tracked) {
  if (!tracked || tracked.schema !== TRACKED_WORKSPACE_TRUTH_SCHEMA) throw new Error("invalid tracked workspace truth schema");
  if (!tracked.state || !Array.isArray(tracked.state.files)) throw new Error("tracked workspace truth requires state files");
  if (typeof tracked.stateHash !== "string" || !tracked.stateHash) throw new Error("tracked workspace truth requires stateHash");
  validateWorkspaceCanonicalSizeHint(tracked.canonicalSizeHint, {
    expectedStateHash: tracked.stateHash,
    expectedFileCount: tracked.state.files.length,
  });
  return true;
}

export function bootstrapTrackedWorkspaceTruth(state) {
  if (!state || !Array.isArray(state.files)) throw new Error("workspace state requires files array");
  const stateHash = hashValue(state);
  const canonicalSizeHint = buildWorkspaceCanonicalSizeHint(state, { stateHash });
  return Object.freeze({
    schema: TRACKED_WORKSPACE_TRUTH_SCHEMA,
    state,
    stateHash,
    canonicalSizeHint,
    generation: 0,
    lastMutation: null,
  });
}

export function applyTrackedWorkspacePointPatch({ tracked, fileId, patch, evidence = {} }) {
  validateTracked(tracked);
  if (!Number.isInteger(fileId)) throw new Error("tracked workspace point patch requires integer fileId");
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("tracked workspace point patch requires patch object");

  const fileIndex = tracked.state.files.findIndex((file) => file.id === fileId);
  if (fileIndex < 0) throw new Error(`unknown file id: ${fileId}`);
  const beforeFile = tracked.state.files[fileIndex];
  const afterFile = Object.freeze({ ...beforeFile, ...patch, id: beforeFile.id });
  const files = [...tracked.state.files];
  files[fileIndex] = afterFile;
  const afterState = { ...tracked.state, files };

  const derivedSize = deriveWorkspacePointCanonicalCharacters({
    hint: tracked.canonicalSizeHint,
    beforeState: tracked.state,
    afterState,
    fileIndex,
  });
  const fingerprint = hashValueWithCanonicalSizeHint(afterState, derivedSize.canonicalCharacters);
  const mutationReceipt = createWorkspacePointMutationReceipt({
    beforeState: tracked.state,
    afterState,
    fileIndex,
    fromStateHash: tracked.stateHash,
    toStateHash: fingerprint.hash,
    evidence: {
      ...structuredClone(evidence),
      canonicalSizeHintReceiptHash: tracked.canonicalSizeHint.receiptHash,
      canonicalSizeCharactersBefore: tracked.canonicalSizeHint.canonicalCharacters,
      canonicalSizeCharactersAfter: derivedSize.canonicalCharacters,
    },
  });
  const canonicalSizeHint = advanceWorkspaceCanonicalSizeHint({
    hint: tracked.canonicalSizeHint,
    beforeState: tracked.state,
    afterState,
    fileIndex,
    toStateHash: fingerprint.hash,
  });

  return Object.freeze({
    schema: TRACKED_WORKSPACE_TRUTH_SCHEMA,
    state: afterState,
    stateHash: fingerprint.hash,
    canonicalSizeHint,
    generation: tracked.generation + 1,
    lastMutation: Object.freeze({
      fileIndex,
      fileId,
      fingerprint,
      mutationReceipt,
      canonicalSizeDeltaCharacters: derivedSize.deltaCharacters,
    }),
  });
}

export function validateTrackedWorkspaceTruth(tracked, { verifyHash = false, verifyCanonicalSize = false } = {}) {
  validateTracked(tracked);
  if (verifyHash && hashValue(tracked.state) !== tracked.stateHash) throw new Error("tracked workspace truth stateHash mismatch");
  if (verifyCanonicalSize) {
    const rebuilt = buildWorkspaceCanonicalSizeHint(tracked.state, { stateHash: tracked.stateHash });
    if (rebuilt.canonicalCharacters !== tracked.canonicalSizeHint.canonicalCharacters) {
      throw new Error("tracked workspace truth canonical size mismatch");
    }
  }
  return true;
}
