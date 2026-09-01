import { hashValue } from "./ignition-core.js";
import {
  advanceWorkspaceCanonicalSizeHint,
  buildWorkspaceCanonicalSizeHint,
  deriveWorkspacePointCanonicalCharacters,
} from "./canonical-size-hint.js";
import {
  buildWorkspaceDomainEntryIndex,
  createWorkspacePointMutationReceipt,
} from "./incremental-domain-index.js";
import { buildWorkspaceFingerprintCheckpoints, WorkspaceFingerprintCheckpoints } from "./checkpointed-workspace-fingerprint.js";
import {
  applyWorkspacePointMutationWithDomainCheckpoints,
  buildWorkspaceDomainHashCheckpoints,
  WorkspaceDomainHashCheckpoints,
} from "./checkpointed-domain-hashes.js";

export const DOMAIN_CHECKPOINTED_WORKSPACE_TRUTH_SCHEMA = "axm.ignition-domain-checkpointed-workspace-truth/v0.21";

function validateTracked(tracked) {
  if (!tracked || tracked.schema !== DOMAIN_CHECKPOINTED_WORKSPACE_TRUTH_SCHEMA) throw new Error("invalid domain-checkpointed workspace truth schema");
  if (!tracked.state || !Array.isArray(tracked.state.files)) throw new Error("domain-checkpointed workspace truth requires state files");
  if (typeof tracked.stateHash !== "string" || !tracked.stateHash) throw new Error("domain-checkpointed workspace truth requires stateHash");
  if (!(tracked.fingerprintCheckpoints instanceof WorkspaceFingerprintCheckpoints)) throw new Error("domain-checkpointed truth requires state fingerprint checkpoints");
  if (!(tracked.domainHashCheckpoints instanceof WorkspaceDomainHashCheckpoints)) throw new Error("domain-checkpointed truth requires domain hash checkpoints");
  if (tracked.fingerprintCheckpoints.stateHash !== tracked.stateHash) throw new Error("state checkpoint hash mismatch");
  if (tracked.domainHashCheckpoints.stateHash !== tracked.stateHash) throw new Error("domain checkpoint hash mismatch");
  if (tracked.canonicalSizeHint?.stateHash !== tracked.stateHash) throw new Error("canonical size hint hash mismatch");
  if (tracked.domainIndex?.identity?.stateHash !== tracked.stateHash) throw new Error("domain identity hash mismatch");
  if (tracked.state.files.length !== tracked.fingerprintCheckpoints.fileCount || tracked.state.files.length !== tracked.domainHashCheckpoints.fileCount) {
    throw new Error("domain-checkpointed truth fileCount mismatch");
  }
  return true;
}

export function bootstrapDomainCheckpointedWorkspaceTruth(state, { checkpointDomains = [] } = {}) {
  if (!state || !Array.isArray(state.files)) throw new Error("workspace state requires files array");
  const fingerprintCheckpoints = buildWorkspaceFingerprintCheckpoints(state);
  const stateHash = fingerprintCheckpoints.stateHash;
  const canonicalSizeHint = buildWorkspaceCanonicalSizeHint(state, { stateHash });
  const domainIndex = buildWorkspaceDomainEntryIndex(state, null, { stateHash });
  const domainHashCheckpoints = buildWorkspaceDomainHashCheckpoints(domainIndex, { domains: checkpointDomains });
  return Object.freeze({
    schema: DOMAIN_CHECKPOINTED_WORKSPACE_TRUTH_SCHEMA,
    state,
    stateHash,
    fingerprintCheckpoints,
    canonicalSizeHint,
    domainIndex,
    domainHashCheckpoints,
    generation: 0,
    lastMutation: null,
  });
}

export function applyDomainCheckpointedWorkspacePointPatch({ tracked, fileId, patch, evidence = {} }) {
  validateTracked(tracked);
  if (!Number.isInteger(fileId)) throw new Error("domain-checkpointed point patch requires integer fileId");
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("domain-checkpointed point patch requires patch object");

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
      truthAdvanceSchema: DOMAIN_CHECKPOINTED_WORKSPACE_TRUTH_SCHEMA,
      canonicalSizeHintReceiptHash: tracked.canonicalSizeHint.receiptHash,
      canonicalSizeCharactersBefore: tracked.canonicalSizeHint.canonicalCharacters,
      canonicalSizeCharactersAfter: derivedSize.canonicalCharacters,
      stateCheckpointGenerationBefore: tracked.fingerprintCheckpoints.generation,
      stateCheckpointGenerationAfter: fingerprintCheckpoints.generation,
      stateCheckpointCharactersRehashed: fingerprintCheckpoints.lastAdvance.canonicalCharactersRehashed,
      domainCheckpointGenerationBefore: tracked.domainHashCheckpoints.generation,
      domainCheckpointDomains: [...tracked.domainHashCheckpoints.selectedDomains],
      domainCheckpointBytes: tracked.domainHashCheckpoints.checkpointBytes,
    },
  });

  const canonicalSizeHint = advanceWorkspaceCanonicalSizeHint({
    hint: tracked.canonicalSizeHint,
    beforeState: tracked.state,
    afterState,
    fileIndex,
    toStateHash,
  });
  const domainAdvance = applyWorkspacePointMutationWithDomainCheckpoints({
    index: tracked.domainIndex,
    checkpointSet: tracked.domainHashCheckpoints,
    mutationReceipt,
    nextState: afterState,
  });
  const domainIndex = domainAdvance.index;
  const domainHashCheckpoints = domainAdvance.checkpointSet;

  if (
    canonicalSizeHint.stateHash !== toStateHash
    || domainIndex.identity.stateHash !== toStateHash
    || domainHashCheckpoints.stateHash !== toStateHash
  ) {
    throw new Error("domain-checkpointed workspace truth consequences diverged");
  }

  return Object.freeze({
    schema: DOMAIN_CHECKPOINTED_WORKSPACE_TRUTH_SCHEMA,
    state: afterState,
    stateHash: toStateHash,
    fingerprintCheckpoints,
    canonicalSizeHint,
    domainIndex,
    domainHashCheckpoints,
    generation: tracked.generation + 1,
    lastMutation: Object.freeze({
      fileIndex,
      fileId,
      mutationReceipt,
      canonicalSizeDeltaCharacters: derivedSize.deltaCharacters,
      fingerprintAdvance: fingerprintCheckpoints.lastAdvance,
      domainAdvance: domainAdvance.metrics,
      consequencesAdvanced: Object.freeze(["canonical-size", "state-fingerprint", "domain-identity", "domain-hash-checkpoints"]),
    }),
  });
}

export function validateDomainCheckpointedWorkspaceTruth(tracked, {
  verifyHash = false,
  verifyCanonicalSize = false,
  verifyDomainIdentity = false,
  verifyDomainCheckpoints = false,
} = {}) {
  validateTracked(tracked);
  if (verifyHash && hashValue(tracked.state) !== tracked.stateHash) throw new Error("domain-checkpointed workspace stateHash mismatch");
  if (verifyCanonicalSize) {
    const rebuilt = buildWorkspaceCanonicalSizeHint(tracked.state, { stateHash: tracked.stateHash });
    if (rebuilt.canonicalCharacters !== tracked.canonicalSizeHint.canonicalCharacters) throw new Error("domain-checkpointed canonical size mismatch");
  }
  if (verifyDomainIdentity || verifyDomainCheckpoints) {
    const rebuilt = buildWorkspaceDomainEntryIndex(tracked.state, tracked.domainIndex.identity, { stateHash: tracked.stateHash });
    for (const [domain, entry] of Object.entries(tracked.domainIndex.identity.domains)) {
      if (rebuilt.identity.domains[domain].hash !== entry.hash) throw new Error(`domain-checkpointed domain hash mismatch: ${domain}`);
    }
    if (verifyDomainCheckpoints) {
      for (const domain of tracked.domainHashCheckpoints.selectedDomains) {
        if (tracked.domainHashCheckpoints.domainHash(domain) !== tracked.domainIndex.identity.domains[domain].hash) {
          throw new Error(`domain checkpoint hash mismatch: ${domain}`);
        }
      }
    }
  }
  return true;
}
