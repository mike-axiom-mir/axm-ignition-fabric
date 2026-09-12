import { hashValue } from "./ignition-core.js";
import {
  advanceWorkspaceCanonicalSizeHint,
  buildWorkspaceCanonicalSizeHint,
  deriveWorkspacePointCanonicalCharacters,
} from "./canonical-size-hint.js";
import {
  applyWorkspacePointMutation,
  buildWorkspaceDomainEntryIndex,
  createWorkspacePointMutationReceipt,
} from "./incremental-domain-index.js";
import { buildWorkspaceFingerprintCheckpoints, WorkspaceFingerprintCheckpoints } from "./checkpointed-workspace-fingerprint.js";

export const UNIFIED_WORKSPACE_TRUTH_SCHEMA = "axm.ignition-unified-workspace-truth/v0.20";

function validateUnified(tracked) {
  if (!tracked || tracked.schema !== UNIFIED_WORKSPACE_TRUTH_SCHEMA) throw new Error("invalid unified workspace truth schema");
  if (!tracked.state || !Array.isArray(tracked.state.files)) throw new Error("unified workspace truth requires state files");
  if (typeof tracked.stateHash !== "string" || !tracked.stateHash) throw new Error("unified workspace truth requires stateHash");
  if (!(tracked.fingerprintCheckpoints instanceof WorkspaceFingerprintCheckpoints)) throw new Error("unified workspace truth requires fingerprint checkpoints");
  if (tracked.fingerprintCheckpoints.stateHash !== tracked.stateHash) throw new Error("unified workspace checkpoint hash mismatch");
  if (tracked.canonicalSizeHint?.stateHash !== tracked.stateHash) throw new Error("unified workspace size hint hash mismatch");
  if (tracked.domainIndex?.identity?.stateHash !== tracked.stateHash) throw new Error("unified workspace domain identity hash mismatch");
  if (tracked.state.files.length !== tracked.fingerprintCheckpoints.fileCount) throw new Error("unified workspace fileCount mismatch");
  return true;
}

export function bootstrapUnifiedWorkspaceTruth(state) {
  if (!state || !Array.isArray(state.files)) throw new Error("workspace state requires files array");
  const fingerprintCheckpoints = buildWorkspaceFingerprintCheckpoints(state);
  const stateHash = fingerprintCheckpoints.stateHash;
  const canonicalSizeHint = buildWorkspaceCanonicalSizeHint(state, { stateHash });
  const domainIndex = buildWorkspaceDomainEntryIndex(state, null, { stateHash });
  return Object.freeze({
    schema: UNIFIED_WORKSPACE_TRUTH_SCHEMA,
    state,
    stateHash,
    fingerprintCheckpoints,
    canonicalSizeHint,
    domainIndex,
    generation: 0,
    lastMutation: null,
  });
}

export function applyUnifiedWorkspacePointPatch({ tracked, fileId, patch, evidence = {} }) {
  validateUnified(tracked);
  if (!Number.isInteger(fileId)) throw new Error("unified workspace point patch requires integer fileId");
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("unified workspace point patch requires patch object");

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

  const fingerprintCheckpoints = tracked.fingerprintCheckpoints.advancePointMutation({
    beforeState: tracked.state,
    afterState,
    fileIndex,
  });
  const toStateHash = fingerprintCheckpoints.stateHash;

  const mutationReceipt = createWorkspacePointMutationReceipt({
    beforeState: tracked.state,
    afterState,
    fileIndex,
    fromStateHash: tracked.stateHash,
    toStateHash,
    evidence: {
      ...structuredClone(evidence),
      truthAdvanceSchema: UNIFIED_WORKSPACE_TRUTH_SCHEMA,
      canonicalSizeHintReceiptHash: tracked.canonicalSizeHint.receiptHash,
      canonicalSizeCharactersBefore: tracked.canonicalSizeHint.canonicalCharacters,
      canonicalSizeCharactersAfter: derivedSize.canonicalCharacters,
      checkpointGenerationBefore: tracked.fingerprintCheckpoints.generation,
      checkpointGenerationAfter: fingerprintCheckpoints.generation,
      checkpointCharactersRehashed: fingerprintCheckpoints.lastAdvance.canonicalCharactersRehashed,
    },
  });

  const canonicalSizeHint = advanceWorkspaceCanonicalSizeHint({
    hint: tracked.canonicalSizeHint,
    beforeState: tracked.state,
    afterState,
    fileIndex,
    toStateHash,
  });

  const domainIndex = applyWorkspacePointMutation({
    index: tracked.domainIndex,
    mutationReceipt,
    nextState: afterState,
  });

  if (canonicalSizeHint.stateHash !== toStateHash || domainIndex.identity.stateHash !== toStateHash) {
    throw new Error("unified workspace truth consequences diverged");
  }

  return Object.freeze({
    schema: UNIFIED_WORKSPACE_TRUTH_SCHEMA,
    state: afterState,
    stateHash: toStateHash,
    fingerprintCheckpoints,
    canonicalSizeHint,
    domainIndex,
    generation: tracked.generation + 1,
    lastMutation: Object.freeze({
      fileIndex,
      fileId,
      mutationReceipt,
      canonicalSizeDeltaCharacters: derivedSize.deltaCharacters,
      fingerprintAdvance: fingerprintCheckpoints.lastAdvance,
      domainAdvance: domainIndex.lastAdvance,
      consequencesAdvanced: Object.freeze(["canonical-size", "state-fingerprint", "domain-identity"]),
    }),
  });
}

export function validateUnifiedWorkspaceTruth(tracked, {
  verifyHash = false,
  verifyCanonicalSize = false,
  verifyDomainIdentity = false,
} = {}) {
  validateUnified(tracked);
  if (verifyHash && hashValue(tracked.state) !== tracked.stateHash) throw new Error("unified workspace truth stateHash mismatch");
  if (verifyCanonicalSize) {
    const rebuilt = buildWorkspaceCanonicalSizeHint(tracked.state, { stateHash: tracked.stateHash });
    if (rebuilt.canonicalCharacters !== tracked.canonicalSizeHint.canonicalCharacters) throw new Error("unified workspace canonical size mismatch");
  }
  if (verifyDomainIdentity) {
    const rebuilt = buildWorkspaceDomainEntryIndex(tracked.state, tracked.domainIndex.identity, { stateHash: tracked.stateHash });
    for (const [domain, entry] of Object.entries(tracked.domainIndex.identity.domains)) {
      if (rebuilt.identity.domains[domain].hash !== entry.hash) throw new Error(`unified workspace domain hash mismatch: ${domain}`);
    }
  }
  return true;
}
