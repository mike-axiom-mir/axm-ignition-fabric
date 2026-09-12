import { hashValue } from "./ignition-core.js";

function normalizedDomains(domainHashes) {
  if (!domainHashes || typeof domainHashes !== "object" || Array.isArray(domainHashes)) {
    throw new Error("domainHashes must be an object");
  }
  const names = Object.keys(domainHashes).sort();
  if (!names.length) throw new Error("domainHashes must not be empty");
  for (const name of names) {
    if (!name || typeof domainHashes[name] !== "string" || !domainHashes[name]) {
      throw new Error("domain hashes require non-empty string names and hashes");
    }
  }
  return names;
}

export function validateDomainIdentity(identity) {
  if (!identity || identity.schema !== "axm.ignition-domain-identity/v0.09") {
    throw new Error("invalid domain identity schema");
  }
  if (typeof identity.stateHash !== "string" || !identity.stateHash) throw new Error("domain identity stateHash required");
  const names = Object.keys(identity.domains || {}).sort();
  if (!names.length) throw new Error("domain identity domains required");
  for (const name of names) {
    const entry = identity.domains[name];
    if (!entry || typeof entry.hash !== "string" || !entry.hash) throw new Error(`invalid domain hash: ${name}`);
    if (!Number.isSafeInteger(entry.revision) || entry.revision < 1) throw new Error(`invalid domain revision: ${name}`);
  }
  const body = {
    schema: identity.schema,
    stateHash: identity.stateHash,
    domains: Object.fromEntries(names.map((name) => [name, { hash: identity.domains[name].hash, revision: identity.domains[name].revision }])),
  };
  if (hashValue(body) !== identity.identityHash) throw new Error("domain identity hash mismatch");
  return true;
}

export function createVersionedDomainIdentity({ stateHash, domainHashes, previousIdentity = null }) {
  if (typeof stateHash !== "string" || !stateHash) throw new Error("stateHash is required");
  const names = normalizedDomains(domainHashes);
  if (previousIdentity) validateDomainIdentity(previousIdentity);

  const domains = {};
  for (const name of names) {
    const previous = previousIdentity?.domains?.[name] || null;
    const revision = previous && previous.hash === domainHashes[name]
      ? previous.revision
      : previous
        ? previous.revision + 1
        : 1;
    domains[name] = { hash: domainHashes[name], revision };
  }

  const body = {
    schema: "axm.ignition-domain-identity/v0.09",
    stateHash,
    domains,
  };
  return Object.freeze({ ...body, identityHash: hashValue(body) });
}

export function domainValidityKey(identity, domains) {
  validateDomainIdentity(identity);
  const names = [...new Set(domains || [])].sort();
  if (!names.length) throw new Error("body validity requires at least one source domain");
  const vector = {};
  for (const name of names) {
    const entry = identity.domains[name];
    if (!entry) throw new Error(`domain identity missing required domain: ${name}`);
    vector[name] = { hash: entry.hash, revision: entry.revision };
  }
  return hashValue({ schema: "axm.ignition-body-validity/v0.09", domains: vector });
}

export function bodyIdentity({ capabilityId, identity, domains }) {
  if (typeof capabilityId !== "string" || !capabilityId) throw new Error("capabilityId is required");
  const sourceDomains = [...new Set(domains || [])].sort();
  const validityKey = domainValidityKey(identity, sourceDomains);
  const body = {
    schema: "axm.ignition-body-identity/v0.09",
    capabilityId,
    sourceDomains,
    validityKey,
  };
  return Object.freeze({ ...body, bodyIdentityHash: hashValue(body) });
}

export function changedIdentityDomains(beforeIdentity, afterIdentity) {
  validateDomainIdentity(beforeIdentity);
  validateDomainIdentity(afterIdentity);
  const names = [...new Set([
    ...Object.keys(beforeIdentity.domains),
    ...Object.keys(afterIdentity.domains),
  ])].sort();
  return names.filter((name) => {
    const a = beforeIdentity.domains[name];
    const b = afterIdentity.domains[name];
    return !a || !b || a.hash !== b.hash || a.revision !== b.revision;
  });
}
