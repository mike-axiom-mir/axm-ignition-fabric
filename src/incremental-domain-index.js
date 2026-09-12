import { createVersionedDomainIdentity, validateDomainIdentity } from "./domain-identity.js";
import { hashValue } from "./ignition-core.js";
import {
  REALISTIC_DOMAINS,
  workspaceFileDomainEntries,
} from "./realistic-mutations.js";

function cloneEntriesByDomain(entriesByDomain) {
  return Object.fromEntries(
    REALISTIC_DOMAINS.map((domain) => [domain, [...entriesByDomain[domain]]])
  );
}

function validateIndex(index) {
  if (!index || index.schema !== "axm.ignition-workspace-domain-index/v0.10") {
    throw new Error("invalid workspace domain index schema");
  }
  if (!Number.isSafeInteger(index.fileCount) || index.fileCount < 0) throw new Error("invalid workspace domain index fileCount");
  validateDomainIdentity(index.identity);
  for (const domain of REALISTIC_DOMAINS) {
    const entries = index.entriesByDomain?.[domain];
    if (!Array.isArray(entries) || entries.length !== index.fileCount) throw new Error(`invalid domain entries: ${domain}`);
  }
  return true;
}

function domainHash(domain, fileCount, entries) {
  return hashValue({ domain, fileCount, entries });
}

function receiptBody(receipt) {
  return {
    schema: receipt.schema,
    fromStateHash: receipt.fromStateHash,
    toStateHash: receipt.toStateHash,
    fileIndex: receipt.fileIndex,
    fileId: receipt.fileId,
    fileCount: receipt.fileCount,
    changedDomains: [...receipt.changedDomains],
    domainEntries: Object.fromEntries(
      REALISTIC_DOMAINS.map((domain) => [domain, {
        before: receipt.domainEntries[domain].before,
        after: receipt.domainEntries[domain].after,
      }])
    ),
    evidence: structuredClone(receipt.evidence || {}),
  };
}

export function buildWorkspaceDomainEntryIndex(state, previousIdentity = null, { stateHash = null } = {}) {
  if (!state || !Array.isArray(state.files)) throw new Error("workspace state requires files array");
  if (previousIdentity) validateDomainIdentity(previousIdentity);

  const entriesByDomain = Object.fromEntries(REALISTIC_DOMAINS.map((domain) => [domain, []]));
  for (let index = 0; index < state.files.length; index += 1) {
    const entries = workspaceFileDomainEntries(state, index);
    for (const domain of REALISTIC_DOMAINS) entriesByDomain[domain].push(entries[domain]);
  }

  const domainHashes = Object.fromEntries(
    REALISTIC_DOMAINS.map((domain) => [domain, domainHash(domain, state.files.length, entriesByDomain[domain])])
  );
  const identity = createVersionedDomainIdentity({
    stateHash: stateHash ?? hashValue(state),
    domainHashes,
    previousIdentity,
  });

  return {
    schema: "axm.ignition-workspace-domain-index/v0.10",
    fileCount: state.files.length,
    identity,
    entriesByDomain,
    lastAdvance: {
      mode: "full-scan",
      filesInspected: state.files.length,
      domainsRehashed: [...REALISTIC_DOMAINS],
    },
  };
}

export function createWorkspacePointMutationReceipt({
  beforeState,
  afterState,
  fileIndex,
  fromStateHash = null,
  toStateHash = null,
  evidence = {},
}) {
  if (!beforeState || !afterState || !Array.isArray(beforeState.files) || !Array.isArray(afterState.files)) {
    throw new Error("workspace mutation receipt requires before/after files arrays");
  }
  if (beforeState.files.length !== afterState.files.length) throw new Error("point mutation cannot change workspace file count");
  if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= beforeState.files.length) throw new Error("point mutation fileIndex out of range");
  const beforeFile = beforeState.files[fileIndex];
  const afterFile = afterState.files[fileIndex];
  if (!beforeFile || !afterFile || beforeFile.id !== afterFile.id) throw new Error("point mutation cannot reorder or replace file identity");

  const beforeEntries = workspaceFileDomainEntries(beforeState, fileIndex);
  const afterEntries = workspaceFileDomainEntries(afterState, fileIndex);
  const changedDomains = REALISTIC_DOMAINS.filter((domain) => beforeEntries[domain] !== afterEntries[domain]);
  if (!changedDomains.length) throw new Error("point mutation has no canonical domain change");

  const body = {
    schema: "axm.ignition-workspace-point-mutation/v0.10",
    fromStateHash: fromStateHash ?? hashValue(beforeState),
    toStateHash: toStateHash ?? hashValue(afterState),
    fileIndex,
    fileId: beforeFile.id,
    fileCount: beforeState.files.length,
    changedDomains,
    domainEntries: Object.fromEntries(
      REALISTIC_DOMAINS.map((domain) => [domain, { before: beforeEntries[domain], after: afterEntries[domain] }])
    ),
    evidence: structuredClone(evidence),
  };
  return Object.freeze({ ...body, receiptHash: hashValue(body) });
}

export function validateWorkspacePointMutationReceipt(receipt, { expectedFrom = null } = {}) {
  if (!receipt || receipt.schema !== "axm.ignition-workspace-point-mutation/v0.10") {
    throw new Error("invalid point mutation receipt schema");
  }
  if (!Number.isSafeInteger(receipt.fileCount) || receipt.fileCount < 0) throw new Error("invalid point mutation fileCount");
  if (!Number.isInteger(receipt.fileIndex) || receipt.fileIndex < 0 || receipt.fileIndex >= receipt.fileCount) throw new Error("invalid point mutation fileIndex");
  if (!Number.isInteger(receipt.fileId)) throw new Error("invalid point mutation fileId");
  const changed = [...new Set(receipt.changedDomains || [])].sort();
  if (!changed.length || changed.some((domain) => !REALISTIC_DOMAINS.includes(domain))) throw new Error("invalid point mutation changedDomains");
  for (const domain of REALISTIC_DOMAINS) {
    const pair = receipt.domainEntries?.[domain];
    if (!pair || typeof pair.before !== "string" || typeof pair.after !== "string") throw new Error(`invalid point mutation domain entries: ${domain}`);
  }
  const derivedChanged = REALISTIC_DOMAINS.filter((domain) => receipt.domainEntries[domain].before !== receipt.domainEntries[domain].after).sort();
  if (JSON.stringify(changed) !== JSON.stringify(derivedChanged)) throw new Error("point mutation changedDomains do not match entry changes");
  if (typeof receipt.fromStateHash !== "string" || !receipt.fromStateHash || typeof receipt.toStateHash !== "string" || !receipt.toStateHash) {
    throw new Error("point mutation state hashes required");
  }
  if (expectedFrom && receipt.fromStateHash !== expectedFrom) throw new Error("point mutation fromStateHash mismatch");
  if (hashValue(receiptBody(receipt)) !== receipt.receiptHash) throw new Error("point mutation receipt hash mismatch");
  return true;
}

export function applyWorkspacePointMutation({ index, mutationReceipt, nextState }) {
  validateIndex(index);
  validateWorkspacePointMutationReceipt(mutationReceipt, { expectedFrom: index.identity.stateHash });
  if (!nextState || !Array.isArray(nextState.files)) throw new Error("next workspace state requires files array");
  if (nextState.files.length !== index.fileCount || mutationReceipt.fileCount !== index.fileCount) {
    throw new Error("point mutation fileCount mismatch");
  }
  const nextFile = nextState.files[mutationReceipt.fileIndex];
  if (!nextFile || nextFile.id !== mutationReceipt.fileId) throw new Error("point mutation target file identity mismatch");

  const actualAfterEntries = workspaceFileDomainEntries(nextState, mutationReceipt.fileIndex);
  for (const domain of REALISTIC_DOMAINS) {
    const current = index.entriesByDomain[domain][mutationReceipt.fileIndex];
    const pair = mutationReceipt.domainEntries[domain];
    if (current !== pair.before) throw new Error(`stale point mutation base entry: ${domain}`);
    if (actualAfterEntries[domain] !== pair.after) throw new Error(`point mutation target entry mismatch: ${domain}`);
  }

  const entriesByDomain = { ...index.entriesByDomain };
  const domainHashes = Object.fromEntries(
    REALISTIC_DOMAINS.map((domain) => [domain, index.identity.domains[domain].hash])
  );

  for (const domain of mutationReceipt.changedDomains) {
    const nextEntries = [...index.entriesByDomain[domain]];
    nextEntries[mutationReceipt.fileIndex] = mutationReceipt.domainEntries[domain].after;
    entriesByDomain[domain] = nextEntries;
    domainHashes[domain] = domainHash(domain, index.fileCount, nextEntries);
  }

  const identity = createVersionedDomainIdentity({
    stateHash: mutationReceipt.toStateHash,
    domainHashes,
    previousIdentity: index.identity,
  });

  return {
    schema: index.schema,
    fileCount: index.fileCount,
    identity,
    entriesByDomain,
    lastAdvance: {
      mode: "point-incremental",
      receiptHash: mutationReceipt.receiptHash,
      filesInspected: 1,
      domainsRehashed: [...mutationReceipt.changedDomains],
      unchangedDomainsNotRehashed: REALISTIC_DOMAINS.filter((domain) => !mutationReceipt.changedDomains.includes(domain)),
    },
  };
}

export function advanceWorkspaceDomainIndex({ index, nextState, mutationReceipt = null, stateHash = null }) {
  validateIndex(index);
  if (!mutationReceipt) {
    const rebuilt = buildWorkspaceDomainEntryIndex(nextState, index.identity, { stateHash });
    return {
      ...rebuilt,
      lastAdvance: {
        ...rebuilt.lastAdvance,
        mode: "full-recompute-fallback",
        reason: "missing-mutation-receipt",
      },
    };
  }
  return applyWorkspacePointMutation({ index, mutationReceipt, nextState });
}
