import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
  REFERENCE_STATE_CLOSURE_CAPABILITY,
  runReferenceStateClosureEvidence
} from "axm-ignition-fabric/reference-state-closure-evidence";

const [pyzPath, revision, outputPath] = process.argv.slice(2);
assert.ok(pyzPath, "pyz path required");
assert.match(revision ?? "", /^[0-9a-f]{40}$/, "provider revision required");
const providerSource = {
  repository: "mike-axiom-mir/axm-state-research",
  revision
};

const first = runReferenceStateClosureEvidence({ pyzPath, providerSource, pythonCommand: process.env.PYTHON || "python3" });
const second = runReferenceStateClosureEvidence({ pyzPath, providerSource, pythonCommand: process.env.PYTHON || "python3" });

assert.equal(first.result, "PASS", first.reason);
assert.deepEqual(second, first, "same portable provider must produce deterministic admitted evidence");
assert.equal(first.capability_id, REFERENCE_STATE_CLOSURE_CAPABILITY);
assert.equal(first.authority.scope, "RESEARCH_EVIDENCE_ONLY");
assert.equal(first.authority.automatic_execution, false);
assert.equal(first.authority.canonical_state_mutation, false);
assert.equal(first.authority.merge, false);
assert.equal(first.authority.canon, false);
assert.equal(first.provider_source.authority, "CALLER_DECLARED");
assert.ok(first.evidence.executions_avoided > 0);
assert.ok(first.evidence.max_derived_reference_bytes < first.evidence.max_dense_reference_bytes);

if (outputPath) {
  writeFileSync(outputPath, `${JSON.stringify(first, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify(first, null, 2));
