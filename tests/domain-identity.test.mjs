import test from "node:test";
import assert from "node:assert/strict";

import { BudgetedRetentionSession } from "../src/budgeted-retention.js";
import { bodyIdentity, changedIdentityDomains, validateDomainIdentity } from "../src/domain-identity.js";
import {
  REALISTIC_DOMAIN_BINDINGS,
  changeWorkspaceImportTarget,
  changeWorkspacePath,
  createWorkspaceDomainIdentity,
  diffWorkspaceDomains,
} from "../src/realistic-mutations.js";
import { buildRealisticRegistry, buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";

test("versioned domain identity increments only changed path domain", () => {
  const before = buildWorkspaceState({ fileCount: 300 });
  const after = changeWorkspacePath(before, 17, ".moved");
  const a = createWorkspaceDomainIdentity(before);
  const b = createWorkspaceDomainIdentity(after, a);
  validateDomainIdentity(a);
  validateDomainIdentity(b);

  assert.deepEqual(changedIdentityDomains(a, b), ["metadata"]);
  for (const [name, entry] of Object.entries(a.domains)) {
    assert.equal(b.domains[name].revision, name === "metadata" ? entry.revision + 1 : entry.revision);
  }
});

test("same-width import mutation advances imports and content-hash identities only", () => {
  const before = buildWorkspaceState({ fileCount: 300 });
  const after = changeWorkspaceImportTarget(before, 12, 13, 14);
  const a = createWorkspaceDomainIdentity(before);
  const b = createWorkspaceDomainIdentity(after, a);
  assert.deepEqual(changedIdentityDomains(a, b), ["content-hash", "imports"]);
  assert.deepEqual(diffWorkspaceDomains(before, after), ["content-hash", "imports"]);
});

test("body validity follows only its declared canonical source domains", () => {
  const before = buildWorkspaceState({ fileCount: 300 });
  const after = changeWorkspacePath(before, 17, ".moved");
  const a = createWorkspaceDomainIdentity(before);
  const b = createWorkspaceDomainIdentity(after, a);

  const searchA = bodyIdentity({ capabilityId: "workspace-search-index", identity: a, domains: ["tokens"] });
  const searchB = bodyIdentity({ capabilityId: "workspace-search-index", identity: b, domains: ["tokens"] });
  const metadataA = bodyIdentity({ capabilityId: "workspace-metadata-index", identity: a, domains: ["metadata"] });
  const metadataB = bodyIdentity({ capabilityId: "workspace-metadata-index", identity: b, domains: ["metadata"] });

  assert.equal(searchA.bodyIdentityHash, searchB.bodyIdentityHash);
  assert.notEqual(metadataA.bodyIdentityHash, metadataB.bodyIdentityHash);
});

test("budget session preserves body whose domain identity remains valid across whole-state change", async () => {
  const before = buildWorkspaceState({ fileCount: 500 });
  const after = changeWorkspacePath(before, 17, ".moved");
  const identityA = createWorkspaceDomainIdentity(before);
  const identityB = createWorkspaceDomainIdentity(after, identityA);
  const session = new BudgetedRetentionSession({
    registry: buildRealisticRegistry(),
    maxCacheBytes: 900_000,
    policy: "value",
    domainBindings: REALISTIC_DOMAIN_BINDINGS,
  });
  try {
    const first = await session.run({ request: realisticRequests.search, state: before, domainIdentity: identityA });
    const second = await session.run({ request: realisticRequests.search, state: after, domainIdentity: identityB });
    assert.equal(first.receipt.cacheHit, false);
    assert.equal(second.receipt.cacheHit, true);
    assert.equal(second.receipt.materializedBytes, 0);
    assert.deepEqual(second.receipt.invalidatedForDomainIdentity, []);
    assert.equal(first.receipt.bodyIdentityHash, second.receipt.bodyIdentityHash);
  } finally {
    await session.close({ state: after });
  }
});

test("budget session releases only body whose own domain identity changed", async () => {
  const before = buildWorkspaceState({ fileCount: 500 });
  const after = changeWorkspacePath(before, 17, ".moved");
  const identityA = createWorkspaceDomainIdentity(before);
  const identityB = createWorkspaceDomainIdentity(after, identityA);
  const session = new BudgetedRetentionSession({
    registry: buildRealisticRegistry(),
    maxCacheBytes: 900_000,
    policy: "value",
    domainBindings: REALISTIC_DOMAIN_BINDINGS,
  });
  try {
    await session.run({ request: realisticRequests.metadata ?? { kind: "metadata" }, state: before, domainIdentity: identityA });
    const changed = await session.run({ request: { kind: "metadata" }, state: after, domainIdentity: identityB });
    assert.equal(changed.receipt.cacheHit, false);
    assert.equal(changed.receipt.invalidatedForDomainIdentity.length, 1);
    assert.equal(changed.receipt.invalidatedForDomainIdentity[0].capabilityId, "workspace-metadata-index");
    assert.equal(changed.receipt.invalidatedForDomainIdentity[0].reason, "domain-identity-change");
  } finally {
    await session.close({ state: after });
  }
});

test("unknown body binding is discarded on identity change instead of guessed valid", async () => {
  const before = buildWorkspaceState({ fileCount: 300 });
  const after = changeWorkspacePath(before, 17, ".moved");
  const identityA = createWorkspaceDomainIdentity(before);
  const identityB = createWorkspaceDomainIdentity(after, identityA);
  const session = new BudgetedRetentionSession({
    registry: buildRealisticRegistry(),
    maxCacheBytes: 100_000,
    policy: "value",
    domainBindings: {},
  });
  try {
    await session.run({ request: realisticRequests.dependencies, state: before, domainIdentity: identityA });
    const changed = await session.run({ request: realisticRequests.dependencies, state: after, domainIdentity: identityB });
    assert.equal(changed.receipt.cacheHit, false);
    assert.equal(changed.receipt.invalidatedForDomainIdentity[0].reason, "domain-identity-unbound");
  } finally {
    await session.close({ state: after });
  }
});

test("workspace array reorder is visible to positional canonical domain identities", () => {
  const before = buildWorkspaceState({ fileCount: 40 });
  const files = [...before.files];
  [files[1], files[2]] = [files[2], files[1]];
  const after = { ...before, files };
  assert.deepEqual(diffWorkspaceDomains(before, after), ["content-hash", "imports", "lint", "metadata", "risk", "symbols", "tokens"]);
});
