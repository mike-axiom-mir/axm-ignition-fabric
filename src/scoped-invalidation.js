import { hashValue } from "./ignition-core.js";

function normalizeChangedDomains(changedDomains) {
  if (!Array.isArray(changedDomains) || !changedDomains.length) {
    throw new Error("changedDomains must be a non-empty array");
  }
  if (changedDomains.some((domain) => typeof domain !== "string" || !domain.trim())) {
    throw new Error("changedDomains must contain non-empty strings");
  }
  return [...new Set(changedDomains)].sort();
}

export function createTransitionReceipt({ fromStateHash, toStateHash, changedDomains, evidence = {} }) {
  if (typeof fromStateHash !== "string" || !fromStateHash) throw new Error("fromStateHash is required");
  if (typeof toStateHash !== "string" || !toStateHash) throw new Error("toStateHash is required");
  const domains = normalizeChangedDomains(changedDomains);

  const body = {
    schema: "axm.ignition-transition/v0.06",
    fromStateHash,
    toStateHash,
    changedDomains: domains,
    evidence: structuredClone(evidence),
  };
  return Object.freeze({ ...body, receiptHash: hashValue(body) });
}

export function validateTransitionReceipt(receipt, { expectedFrom, expectedTo } = {}) {
  if (!receipt || receipt.schema !== "axm.ignition-transition/v0.06") throw new Error("invalid transition receipt schema");
  if (typeof receipt.fromStateHash !== "string" || !receipt.fromStateHash) throw new Error("transition fromStateHash is required");
  if (typeof receipt.toStateHash !== "string" || !receipt.toStateHash) throw new Error("transition toStateHash is required");
  const domains = normalizeChangedDomains(receipt.changedDomains);
  if (
    domains.length !== receipt.changedDomains.length
    || domains.some((domain, index) => domain !== receipt.changedDomains[index])
  ) {
    throw new Error("transition changedDomains must be sorted and unique");
  }
  const body = {
    schema: receipt.schema,
    fromStateHash: receipt.fromStateHash,
    toStateHash: receipt.toStateHash,
    changedDomains: domains,
    evidence: structuredClone(receipt.evidence),
  };
  if (hashValue(body) !== receipt.receiptHash) throw new Error("transition receipt hash mismatch");
  if (expectedFrom && receipt.fromStateHash !== expectedFrom) throw new Error("transition fromStateHash mismatch");
  if (expectedTo && receipt.toStateHash !== expectedTo) throw new Error("transition toStateHash mismatch");
  return true;
}

export function createDomainInvalidationResolver(domainBindings) {
  const source = domainBindings ?? {};
  if (typeof source !== "object" || Array.isArray(source)) {
    throw new Error("domainBindings must be an object");
  }

  const normalized = new Map();
  for (const [capabilityId, domains] of Object.entries(source)) {
    if (!capabilityId.trim()) throw new Error("domain binding capability id must be non-empty");
    if (!Array.isArray(domains)) {
      throw new Error(`domain binding for ${capabilityId} must be an array`);
    }
    if (domains.some((domain) => typeof domain !== "string" || !domain.trim())) {
      throw new Error(`domain binding for ${capabilityId} must contain non-empty strings`);
    }
    normalized.set(capabilityId, new Set(domains));
  }

  return ({ transitionReceipt, cachedCapabilityIds = [] }) => {
    validateTransitionReceipt(transitionReceipt);
    const changed = new Set(transitionReceipt.changedDomains);
    const invalidatedCapabilityIds = [];
    const retainedCapabilityIds = [];

    for (const capabilityId of [...cachedCapabilityIds].sort()) {
      const domains = normalized.get(capabilityId);
      const invalid = !domains || [...domains].some((domain) => changed.has(domain));
      if (invalid) invalidatedCapabilityIds.push(capabilityId);
      else retainedCapabilityIds.push(capabilityId);
    }

    return {
      schema: "axm.ignition-invalidation-resolution/v0.06",
      transitionReceiptHash: transitionReceipt.receiptHash,
      changedDomains: [...transitionReceipt.changedDomains],
      invalidatedCapabilityIds,
      retainedCapabilityIds,
      unknownBindingsInvalidateByDefault: true,
    };
  };
}
