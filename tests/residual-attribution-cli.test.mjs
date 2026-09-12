import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, "..", "scripts", "residual-attribution-probe.mjs");

function runProbe() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--expose-gc", probe, "2500"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`residual attribution probe exit ${code}`));
      try {
        resolve(JSON.parse(stdout.trim().split("\n").at(-1)));
      } catch (error) {
        reject(error);
      }
    });
  });
}

test("v0.15 residual attribution preserves report truth and explicit lifetime stages", async () => {
  const row = await runProbe();
  assert.equal(row.schema, "axm.ignition-whole-process-residual-probe/v0.15");
  assert.equal(row.logicalRun.resultHash, "daa06e7e");
  assert.equal(row.logicalRun.totalMaterializedBytes, 147572);
  assert.equal(row.logicalRun.declaredPeakLiveBodyBytes, 39820);
  assert.equal(row.logicalRun.cacheBytesAfter, 0);
  assert.equal(row.logicalRun.resourceSnapshotsStoredInReceipt, 0);
  assert.equal(row.runPeak.deltaFromPreRun.arrayBuffers, 39820);

  const names = row.stages.map((stage) => stage.name);
  assert.deepEqual(names, [
    "boot-modules-loaded",
    "registry-created",
    "session-created",
    "canonical-state-created",
    "state-fingerprint-retained",
    "run-result-retained",
    "session-closed-result-retained",
    "run-result-dropped",
    "fingerprint-variable-dropped",
    "canonical-state-dropped",
    "framework-objects-dropped",
  ]);
  assert.equal(row.canonicalStateFacts.fileCount, 2500);
  assert.ok(row.canonicalStateFacts.sourceCharacters > 0);
  assert.ok(row.canonicalStateFacts.sourceUtf8Bytes >= row.canonicalStateFacts.sourceCharacters);
});
