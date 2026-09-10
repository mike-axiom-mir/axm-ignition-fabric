import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  admitReferenceStateClosureEvidence,
  runReferenceStateClosureEvidence
} from "../src/reference-state-closure-evidence.js";

const SOURCE = {
  repository: "mike-axiom-mir/axm-state-research",
  revision: "ec159470bef52974dad25292ea7a6b34be54ccd4"
};
const PROVIDER_AUTHORITY = {
  automatic_execution: false,
  automatic_selection: false,
  installation: false,
  merge: false,
  canon: false
};
const PORTABLE_TRUTH = [
  "software runtime model; no neural or hardware performance claim",
  "portable integrity is not producer authentication or CANON authority",
  "derived reference state remains rebuildable from canonical fixture state",
  "a passing fixture is evidence for this declared workload, not a universal proof"
];
const REPORT_TRUTH = [
  "software runtime model; no neural or hardware performance claim",
  "derived reference total is rebuildable from canonical fixture state",
  "integer arithmetic and canonical JSON make replay byte-inspectable",
  "a passing fixture is evidence for this workload, not a universal proof"
];
const DIGEST = "1".repeat(64);
const OTHER_DIGEST = "2".repeat(64);

function validBundle(artifactSha256 = "a".repeat(64)) {
  const members = {
    LICENSE: { bytes: 1, sha256: "3".repeat(64) },
    "__main__.py": { bytes: 2, sha256: "4".repeat(64) },
    "experiment.py": { bytes: 3, sha256: "5".repeat(64) },
    "fixture.json": { bytes: 4, sha256: "6".repeat(64) }
  };
  return {
    artifactSha256,
    providerSource: SOURCE,
    verification: {
      schema: "axm.reference-state-closure.portable-verification.v1",
      result: "PASS",
      artifact_sha256: artifactSha256,
      capability_id: "axm.state-research.reference-state-closure.experiment/v1",
      provider_members: members,
      authority: PROVIDER_AUTHORITY,
      truth_boundary: PORTABLE_TRUTH
    },
    description: {
      schema: "axm.reference-state-closure.portable.v1",
      capability_id: "axm.state-research.reference-state-closure.experiment/v1",
      runtime: {
        python: ">=3.10",
        third_party_dependencies: [],
        network_required: false,
        account_required: false,
        ai_model_required: false
      },
      entrypoints: {},
      provider: {
        repository: "mike-axiom-mir/axm-state-research",
        experiment_schema: "axm.reference-state-closure.report.v1",
        fixture_schema: "axm.reference-state-closure.fixture.v1",
        license: "Apache-2.0"
      },
      members,
      authority: PROVIDER_AUTHORITY,
      truth_boundary: PORTABLE_TRUTH
    },
    report: {
      schema: "axm.reference-state-closure.report.v1",
      status: "PASS",
      fixture_sha256: "7f65abe33661b1deef2bac40052efff68088cb2d461e14d6a738f1556fb5d6a5",
      correctness: {
        canonical_output_equality_A_B: true,
        normalization_equality_A_B: true,
        replay_digest_A: DIGEST,
        replay_digest_B: DIGEST,
        aggressive_control_divergences_A_C: 12,
        missed_reference_contributions_C: 10
      },
      work: {
        dense_body_executions_A: 104,
        sparse_body_executions_B: 18,
        executions_avoided_B: 86
      },
      state_encoding: {
        max_dense_reference_bytes_A: 130,
        max_derived_reference_bytes_B: 24
      },
      truth_boundary: REPORT_TRUTH
    }
  };
}

function mutate(bundle, fn) {
  const copy = structuredClone(bundle);
  fn(copy);
  return copy;
}

test("admits exact portable evidence as research-only evidence", () => {
  const receipt = admitReferenceStateClosureEvidence(validBundle());
  assert.equal(receipt.result, "PASS");
  assert.equal(receipt.authority.scope, "RESEARCH_EVIDENCE_ONLY");
  assert.equal(receipt.authority.canonical_state_mutation, false);
  assert.equal(receipt.provider_source.authority, "CALLER_DECLARED");
  assert.equal(receipt.evidence.executions_avoided, 86);
});

test("rejects provider authority widening", () => {
  const bundle = mutate(validBundle(), (value) => { value.description.authority.automatic_execution = true; });
  assert.match(admitReferenceStateClosureEvidence(bundle).reason, /authority drift/);
});

test("rejects dense/sparse correctness drift", () => {
  const bundle = mutate(validBundle(), (value) => { value.report.correctness.canonical_output_equality_A_B = false; });
  assert.match(admitReferenceStateClosureEvidence(bundle).reason, /equality not established/);
});

test("rejects unequal replay digests", () => {
  const bundle = mutate(validBundle(), (value) => { value.report.correctness.replay_digest_B = OTHER_DIGEST; });
  assert.match(admitReferenceStateClosureEvidence(bundle).reason, /replay digest mismatch/);
});

test("rejects a changed default fixture identity", () => {
  const bundle = mutate(validBundle(), (value) => { value.report.fixture_sha256 = OTHER_DIGEST; });
  assert.match(admitReferenceStateClosureEvidence(bundle).reason, /fixture identity mismatch/);
});

test("rejects caller-declared provenance for a different repository", () => {
  const bundle = mutate(validBundle(), (value) => { value.providerSource.repository = "example/other"; });
  assert.match(admitReferenceStateClosureEvidence(bundle).reason, /repository mismatch/);
});

test("returns HOLD without executing when the optional portable provider is absent", () => {
  const receipt = runReferenceStateClosureEvidence({
    pyzPath: join(tmpdir(), "does-not-exist-reference-state-closure.pyz"),
    providerSource: SOURCE,
    runner() { throw new Error("must not run"); }
  });
  assert.equal(receipt.result, "HOLD");
  assert.equal(receipt.authority.scope, "RESEARCH_EVIDENCE_ONLY");
});

test("executes verify, describe, run in order and binds the local artifact hash", () => {
  const dir = mkdtempSync(join(tmpdir(), "axm-reference-state-"));
  const pyzPath = join(dir, "reference-state-closure.pyz");
  writeFileSync(pyzPath, "portable-test-artifact", "utf8");
  const artifactSha256 = createHash("sha256").update("portable-test-artifact").digest("hex");
  const bundle = validBundle(artifactSha256);
  const calls = [];
  const outputs = {
    verify: bundle.verification,
    describe: bundle.description,
    run: bundle.report
  };
  const receipt = runReferenceStateClosureEvidence({
    pyzPath,
    providerSource: SOURCE,
    runner(_python, observedPath, command) {
      calls.push([observedPath, command]);
      return { status: 0, stdout: JSON.stringify(outputs[command]), stderr: "" };
    }
  });
  assert.equal(receipt.result, "PASS");
  assert.equal(receipt.artifact_sha256, artifactSha256);
  assert.deepEqual(calls.map((entry) => entry[1]), ["verify", "describe", "run"]);
});

test("fails closed on non-JSON provider output", () => {
  const dir = mkdtempSync(join(tmpdir(), "axm-reference-state-"));
  const pyzPath = join(dir, "reference-state-closure.pyz");
  writeFileSync(pyzPath, "portable-test-artifact", "utf8");
  const receipt = runReferenceStateClosureEvidence({
    pyzPath,
    providerSource: SOURCE,
    runner() { return { status: 0, stdout: "not json", stderr: "" }; }
  });
  assert.equal(receipt.result, "HOLD");
  assert.match(receipt.reason, /non-JSON/);
});
