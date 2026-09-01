import { hashValue } from "./ignition-core.js";

export function createTransitionReceipt({ fromStateHash, toStateHash, changedDomains, evidence = {} }) {
  if (typeof fromStateHash !== "string" || !fromStateHash) throw new Error("fromStateHash is required");
  if (typeof toStateHash !== "string" || !toStateHash) throw new Error("toStateHash is required");
  const domains = [...new Set(changedDomains || [])].sort();
  if (!domains.length) throw new Error("changedDomains must not be empty");
  if (domains.some((domain) => typeof domain !== "string" || !domain)) throw new Error("changedDomains must be strings");

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
  const body = {
    schema: receipt.schema,
    fromStateHash: receipt.fromStateHash,
    toStateHash: receipt.toStateHash,
    changedDomains: [...receipt.changedDomains],
    evidence: structuredClone(receipt.evidence),
  };
  if (hashValue(body) !== receipt.receiptHash) throw new Error("transition receipt hash mismatch");
  if (expectedFrom && receipt.fromStateHash !== expectedFrom) throw new Error("transition fromStateHash mismatch");
  if (expectedTo && receipt.toStateHash !== expectedTo) throw new Error("transition toStateHash mismatch");
  return true;
}

export function createDomainInvalidationResolver(domainBindings) {
  const normalized = new Map();
  for (const [capabilityId, domains] of Object.entries(domainBindings || {})) {
    normalized.set(capabilityId, new Set(domains || []));
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
