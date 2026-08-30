import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const probePath = fileURLToPath(new URL("../scripts/memory-probe.mjs", import.meta.url));

function probe(mode, scenario) {
  const stdout = execFileSync(
    process.execPath,
    ["--expose-gc", probePath, mode, scenario],
    { encoding: "utf8" }
  );
  return JSON.parse(stdout.trim());
}

test("Ignition uses fewer real ArrayBuffer allocations for a narrow request", () => {
  const eager = probe("eager", "numbers");
  const ignition = probe("ignition", "numbers");

  assert.equal(eager.resultHash, ignition.resultHash);
  assert.deepEqual(eager.executedCapabilityIds, ignition.executedCapabilityIds);
  assert.ok(ignition.actualMaterializedBytes < eager.actualMaterializedBytes);
  assert.ok(ignition.memory.materializeDelta.arrayBuffers < eager.memory.materializeDelta.arrayBuffers);

  const declaredSavings = eager.actualMaterializedBytes - ignition.actualMaterializedBytes;
  const measuredSavings = eager.memory.materializeDelta.arrayBuffers - ignition.memory.materializeDelta.arrayBuffers;
  assert.ok(declaredSavings >= 16 * 1024 * 1024);
  assert.ok(measuredSavings >= 16 * 1024 * 1024);
});

test("released capability bodies no longer remain as live ArrayBuffer working set", () => {
  const eager = probe("eager", "lookup");
  assert.ok(eager.memory.afterRelease.arrayBuffers < eager.memory.afterMaterialize.arrayBuffers);
});
