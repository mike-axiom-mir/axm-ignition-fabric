import { fnv1a32, hashValue } from "./ignition-core.js";
import { createVersionedDomainIdentity } from "./domain-identity.js";
import { createDomainInvalidationResolver, createTransitionReceipt } from "./scoped-invalidation.js";

const encoder = new TextEncoder();
export const REALISTIC_DOMAINS = Object.freeze(["content-hash", "imports", "lint", "metadata", "risk", "symbols", "tokens"]);

export const REALISTIC_DOMAIN_BINDINGS = Object.freeze({
  "workspace-metadata-index": ["metadata"],
  "workspace-dependency-index": ["imports"],
  "workspace-symbol-index": ["symbols"],
  "workspace-search-index": ["tokens"],
  "workspace-duplicate-index": ["content-hash"],
  "workspace-lint-index": ["lint"],
  "workspace-report-projection": ["risk"],
});

export const resolveRealisticInvalidation = createDomainInvalidationResolver(REALISTIC_DOMAIN_BINDINGS);

function importSignature(content) {
  const values = [];
  const pattern = /file-(\d+)\.js/g;
  let match;
  while ((match = pattern.exec(content))) values.push(Number(match[1]));
  return values.join(",");
}

function symbolSignature(content) {
  const values = [];
  const pattern = /export const ([A-Za-z0-9_]+)/g;
  let match;
  while ((match = pattern.exec(content))) values.push(match[1]);
  return values.join(",");
}

function tokenSignature(content) {
  return (content.toLowerCase().match(/[a-z_][a-z0-9_]*/g) || []).map(fnv1a32).join(",");
}

function lintSignature(content) {
  return content.includes("TODO") ? "TODO" : content.includes("FIXME") ? "FIXME" : "NONE";
}

function riskSignature(content) {
  return `${content.length}:${content.includes("TODO") ? 1 : 0}`;
}

function fileDomainSignatures(file) {
  return {
    metadata: `${file.id}|${file.packageId}|${file.language}|${file.path}|${encoder.encode(file.content).byteLength}`,
    imports: importSignature(file.content),
    symbols: symbolSignature(file.content),
    tokens: tokenSignature(file.content),
    "content-hash": fnv1a32(file.content),
    lint: lintSignature(file.content),
    risk: riskSignature(file.content),
  };
}

export function workspaceFileDomainEntries(state, index) {
  if (!state || !Array.isArray(state.files)) throw new Error("workspace state requires files array");
  if (!Number.isInteger(index) || index < 0 || index >= state.files.length) throw new Error("workspace file index out of range");
  const file = state.files[index];
  const signatures = fileDomainSignatures(file);
  return Object.freeze(Object.fromEntries(
    REALISTIC_DOMAINS.map((domain) => [domain, `${index}|${file.id}|${signatures[domain]}`])
  ));
}

export function workspaceDomainHashes(state) {
  if (!state || !Array.isArray(state.files)) throw new Error("workspace state requires files array");
  const parts = Object.fromEntries(REALISTIC_DOMAINS.map((domain) => [domain, []]));
  state.files.forEach((_file, index) => {
    const entries = workspaceFileDomainEntries(state, index);
    for (const domain of REALISTIC_DOMAINS) parts[domain].push(entries[domain]);
  });
  return Object.freeze(Object.fromEntries(
    REALISTIC_DOMAINS.map((domain) => [
      domain,
      hashValue({ domain, fileCount: state.files.length, entries: parts[domain] }),
    ])
  ));
}

export function createWorkspaceDomainIdentity(state, previousIdentity = null) {
  return createVersionedDomainIdentity({
    stateHash: hashValue(state),
    domainHashes: workspaceDomainHashes(state),
    previousIdentity,
  });
}

export function diffWorkspaceDomains(before, after) {
  const a = workspaceDomainHashes(before);
  const b = workspaceDomainHashes(after);
  return REALISTIC_DOMAINS.filter((domain) => a[domain] !== b[domain]);
}

export function createWorkspaceTransitionReceipt(before, after) {
  const changedDomains = diffWorkspaceDomains(before, after);
  if (!changedDomains.length) throw new Error("workspace transition has no observed domain change");
  return createTransitionReceipt({
    fromStateHash: hashValue(before),
    toStateHash: hashValue(after),
    changedDomains,
    evidence: {
      beforeSchema: before.schema,
      afterSchema: after.schema,
      fileCountBefore: before.files.length,
      fileCountAfter: after.files.length,
    },
  });
}

export function patchWorkspaceFile(state, fileId, patch) {
  let found = false;
  const files = state.files.map((file) => {
    if (file.id !== fileId) return file;
    found = true;
    return { ...file, ...patch, id: file.id };
  });
  if (!found) throw new Error(`unknown file id: ${fileId}`);
  return { ...state, files };
}

export function changeWorkspacePath(state, fileId, suffix) {
  const file = state.files.find((entry) => entry.id === fileId);
  if (!file) throw new Error(`unknown file id: ${fileId}`);
  return patchWorkspaceFile(state, fileId, { path: `${file.path}${suffix}` });
}

export function changeWorkspaceImportTarget(state, fileId, fromTarget, toTarget) {
  const file = state.files.find((entry) => entry.id === fileId);
  if (!file) throw new Error(`unknown file id: ${fileId}`);
  const needle = `file-${fromTarget}.js`;
  const replacement = `file-${toTarget}.js`;
  if (!file.content.includes(needle)) throw new Error(`file ${fileId} does not import ${needle}`);
  return patchWorkspaceFile(state, fileId, { content: file.content.replace(needle, replacement) });
}
