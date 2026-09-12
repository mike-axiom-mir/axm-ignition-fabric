import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { stableStringify } from "./canonical-fingerprint-primitives.js";

export const REFERENCE_STATE_CLOSURE_EVIDENCE_SCHEMA = "axm.ignition.reference-state-closure-evidence/v0.1";
export const REFERENCE_STATE_CLOSURE_CAPABILITY = "axm.state-research.reference-state-closure.experiment/v1";

const PORTABLE_SCHEMA = "axm.reference-state-closure.portable.v1";
const VERIFY_SCHEMA = "axm.reference-state-closure.portable-verification.v1";
const REPORT_SCHEMA = "axm.reference-state-closure.report.v1";
const FIXTURE_SHA256 = "7f65abe33661b1deef2bac40052efff68088cb2d461e14d6a738f1556fb5d6a5";
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

const PROVIDER_AUTHORITY = Object.freeze({
  automatic_execution: false,
  automatic_selection: false,
  installation: false,
  merge: false,
  canon: false
});

const EVIDENCE_AUTHORITY = Object.freeze({
  scope: "RESEARCH_EVIDENCE_ONLY",
  automatic_selection: false,
  automatic_execution: false,
  canonical_state_mutation: false,
  merge: false,
  canon: false
});

const PORTABLE_TRUTH_BOUNDARY = Object.freeze([
  "software runtime model; no neural or hardware performance claim",
  "portable integrity is not producer authentication or CANON authority",
  "derived reference state remains rebuildable from canonical fixture state",
  "a passing fixture is evidence for this declared workload, not a universal proof"
]);

const REPORT_TRUTH_BOUNDARY = Object.freeze([
  "software runtime model; no neural or hardware performance claim",
  "derived reference total is rebuildable from canonical fixture state",
  "integer arithmetic and canonical JSON make replay byte-inspectable",
  "a passing fixture is evidence for this workload, not a universal proof"
]);

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Value(value) {
  return sha256Bytes(Buffer.from(stableStringify(value), "utf8"));
}

function sameValue(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function requireExact(condition, message) {
  if (!condition) throw new Error(message);
}

function requireSha256(value, field) {
  requireExact(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), `${field} must be lowercase sha256`);
}

function validateProviderSource(providerSource) {
  requireExact(providerSource && typeof providerSource === "object" && !Array.isArray(providerSource), "providerSource is required");
  requireExact(providerSource.repository === "mike-axiom-mir/axm-state-research", "providerSource.repository mismatch");
  requireExact(typeof providerSource.revision === "string" && /^[0-9a-f]{40}$/.test(providerSource.revision), "providerSource.revision must be a git sha");
  return Object.freeze({ repository: providerSource.repository, revision: providerSource.revision, authority: "CALLER_DECLARED" });
}

function validateVerification(verification, artifactSha256) {
  requireExact(verification?.schema === VERIFY_SCHEMA, "portable verification schema mismatch");
  requireExact(verification?.result === "PASS", "portable verification did not PASS");
  requireExact(verification?.capability_id === REFERENCE_STATE_CLOSURE_CAPABILITY, "portable verification capability mismatch");
  requireSha256(verification?.artifact_sha256, "verification.artifact_sha256");
  requireExact(verification.artifact_sha256 === artifactSha256, "portable artifact sha256 mismatch");
  requireExact(sameValue(verification?.authority, PROVIDER_AUTHORITY), "portable verification authority drift");
  requireExact(sameValue(verification?.truth_boundary, PORTABLE_TRUTH_BOUNDARY), "portable verification truth boundary drift");
  requireExact(verification?.provider_members && typeof verification.provider_members === "object" && !Array.isArray(verification.provider_members), "portable verification member evidence missing");
}

function validateDescription(description, verification) {
  requireExact(description?.schema === PORTABLE_SCHEMA, "portable descriptor schema mismatch");
  requireExact(description?.capability_id === REFERENCE_STATE_CLOSURE_CAPABILITY, "portable descriptor capability mismatch");
  requireExact(sameValue(description?.authority, PROVIDER_AUTHORITY), "portable descriptor authority drift");
  requireExact(sameValue(description?.truth_boundary, PORTABLE_TRUTH_BOUNDARY), "portable descriptor truth boundary drift");
  requireExact(description?.runtime?.python === ">=3.10", "portable python floor mismatch");
  requireExact(Array.isArray(description?.runtime?.third_party_dependencies) && description.runtime.third_party_dependencies.length === 0, "portable third-party dependency contract drift");
  requireExact(description?.runtime?.network_required === false, "portable network contract drift");
  requireExact(description?.runtime?.account_required === false, "portable account contract drift");
  requireExact(description?.runtime?.ai_model_required === false, "portable AI contract drift");
  requireExact(description?.provider?.repository === "mike-axiom-mir/axm-state-research", "portable provider repository mismatch");
  requireExact(description?.provider?.experiment_schema === REPORT_SCHEMA, "portable report schema declaration mismatch");
  requireExact(description?.provider?.fixture_schema === "axm.reference-state-closure.fixture.v1", "portable fixture schema declaration mismatch");
  requireExact(description?.provider?.license === "Apache-2.0", "portable provider license mismatch");
  requireExact(sameValue(description?.members, verification?.provider_members), "portable member evidence disagreement");
}

function validateReport(report) {
  requireExact(report?.schema === REPORT_SCHEMA, "experiment report schema mismatch");
  requireExact(report?.status === "PASS", "experiment report did not PASS");
  requireExact(report?.fixture_sha256 === FIXTURE_SHA256, "default fixture identity mismatch");
  requireExact(sameValue(report?.truth_boundary, REPORT_TRUTH_BOUNDARY), "experiment truth boundary drift");

  const correctness = report?.correctness;
  requireExact(correctness?.canonical_output_equality_A_B === true, "dense/sparse canonical output equality not established");
  requireExact(correctness?.normalization_equality_A_B === true, "dense/sparse normalization equality not established");
  requireSha256(correctness?.replay_digest_A, "correctness.replay_digest_A");
  requireSha256(correctness?.replay_digest_B, "correctness.replay_digest_B");
  requireExact(correctness.replay_digest_A === correctness.replay_digest_B, "dense/sparse replay digest mismatch");
  requireExact(Number.isSafeInteger(correctness?.aggressive_control_divergences_A_C) && correctness.aggressive_control_divergences_A_C > 0, "negative control did not diverge");
  requireExact(Number.isSafeInteger(correctness?.missed_reference_contributions_C) && correctness.missed_reference_contributions_C > 0, "negative control missed-reference witness absent");

  const work = report?.work;
  requireExact(Number.isSafeInteger(work?.dense_body_executions_A) && Number.isSafeInteger(work?.sparse_body_executions_B), "execution counts missing");
  requireExact(work.sparse_body_executions_B < work.dense_body_executions_A, "sparse execution did not reduce body executions");
  requireExact(work?.executions_avoided_B === work.dense_body_executions_A - work.sparse_body_executions_B, "execution avoidance arithmetic mismatch");

  const encoding = report?.state_encoding;
  requireExact(Number.isSafeInteger(encoding?.max_dense_reference_bytes_A) && Number.isSafeInteger(encoding?.max_derived_reference_bytes_B), "reference encoding evidence missing");
  requireExact(encoding.max_derived_reference_bytes_B < encoding.max_dense_reference_bytes_A, "derived reference encoding did not reduce bytes");
}

function parseCommandJson(command, result) {
  if (result?.error) throw result.error;
  requireExact(result && typeof result.status === "number", `${command} did not return a process status`);
  requireExact(result.status === 0, `${command} exited ${result.status}${result.stderr ? `: ${String(result.stderr).trim()}` : ""}`);
  const stdout = String(result.stdout ?? "");
  requireExact(Buffer.byteLength(stdout, "utf8") <= MAX_OUTPUT_BYTES, `${command} output exceeded byte ceiling`);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${command} returned non-JSON output`);
  }
}

function defaultRunner(pythonCommand, pyzPath, command) {
  return spawnSync(pythonCommand, [pyzPath, command], {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
    shell: false
  });
}

function hold(reason) {
  return Object.freeze({
    schema: REFERENCE_STATE_CLOSURE_EVIDENCE_SCHEMA,
    result: "HOLD",
    reason: String(reason),
    authority: EVIDENCE_AUTHORITY
  });
}

export function admitReferenceStateClosureEvidence({ artifactSha256, verification, description, report, providerSource }) {
  try {
    requireSha256(artifactSha256, "artifactSha256");
    const source = validateProviderSource(providerSource);
    validateVerification(verification, artifactSha256);
    validateDescription(description, verification);
    validateReport(report);

    return Object.freeze({
      schema: REFERENCE_STATE_CLOSURE_EVIDENCE_SCHEMA,
      result: "PASS",
      capability_id: REFERENCE_STATE_CLOSURE_CAPABILITY,
      artifact_sha256: artifactSha256,
      provider_source: source,
      report_sha256: sha256Value(report),
      evidence: Object.freeze({
        fixture_sha256: report.fixture_sha256,
        replay_digest: report.correctness.replay_digest_A,
        dense_body_executions: report.work.dense_body_executions_A,
        sparse_body_executions: report.work.sparse_body_executions_B,
        executions_avoided: report.work.executions_avoided_B,
        max_dense_reference_bytes: report.state_encoding.max_dense_reference_bytes_A,
        max_derived_reference_bytes: report.state_encoding.max_derived_reference_bytes_B,
        negative_control_divergences: report.correctness.aggressive_control_divergences_A_C
      }),
      truth_boundary: Object.freeze([
        ...REPORT_TRUTH_BOUNDARY,
        "Ignition records this as external research evidence; it does not establish Ignition performance or runtime superiority",
        "artifact hashes establish content identity, not provider authorship"
      ]),
      authority: EVIDENCE_AUTHORITY
    });
  } catch (error) {
    return hold(error instanceof Error ? error.message : error);
  }
}

export function runReferenceStateClosureEvidence({ pyzPath, providerSource, pythonCommand = "python3", runner = defaultRunner } = {}) {
  try {
    requireExact(typeof pyzPath === "string" && pyzPath.length > 0, "pyzPath is required");
    requireExact(typeof pythonCommand === "string" && pythonCommand.length > 0, "pythonCommand is required");
    requireExact(typeof runner === "function", "runner must be a function");
    const stat = lstatSync(pyzPath);
    requireExact(stat.isFile() && !stat.isSymbolicLink(), "portable artifact must be a regular non-symlink file");
    requireExact(stat.size > 0 && stat.size <= MAX_ARTIFACT_BYTES, "portable artifact size outside admission ceiling");
    const artifactSha256 = sha256Bytes(readFileSync(pyzPath));
    const verification = parseCommandJson("verify", runner(pythonCommand, pyzPath, "verify"));
    const description = parseCommandJson("describe", runner(pythonCommand, pyzPath, "describe"));
    const report = parseCommandJson("run", runner(pythonCommand, pyzPath, "run"));
    return admitReferenceStateClosureEvidence({ artifactSha256, verification, description, report, providerSource });
  } catch (error) {
    return hold(error instanceof Error ? error.message : error);
  }
}
