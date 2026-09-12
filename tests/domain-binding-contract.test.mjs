import test from "node:test";
import assert from "node:assert/strict";

import { createDomainInvalidationResolver, createTransitionReceipt } from "../src/scoped-invalidation.js";

test("domain binding resolver rejects string shorthand that could retain stale bodies", () => {
  assert.throws(
    () => createDomainInvalidationResolver({ "workspace-dependency-index": "imports" }),
    /must be an array/,
  );
});

test("domain binding resolver rejects blank domain names", () => {
  assert.throws(
    () => createDomainInvalidationResolver({ "workspace-dependency-index": ["imports", ""] }),
    /non-empty strings/,
  );
});

test("explicit empty-domain binding is a deliberate state-independent capability contract", () => {
  const resolve = createDomainInvalidationResolver({ "constant-capability": [] });
  const transitionReceipt = createTransitionReceipt({
    fromStateHash: "before",
    toStateHash: "after",
    changedDomains: ["metadata"],
  });
  const resolution = resolve({
    transitionReceipt,
    cachedCapabilityIds: ["constant-capability", "unknown-capability"],
  });
  assert.deepEqual(resolution.retainedCapabilityIds, ["constant-capability"]);
  assert.deepEqual(resolution.invalidatedCapabilityIds, ["unknown-capability"]);
});
