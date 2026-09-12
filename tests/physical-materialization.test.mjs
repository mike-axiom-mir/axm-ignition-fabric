import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { CapabilityRegistry, executeIgnitionRun } from "../src/ignition-core.js";

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

test("release hooks run for every materialized capability without retaining runtime bodies in receipts", async () => {
  const released = [];
  const registry = new CapabilityRegistry([
    {
      id: "release-proof",
      match: () => true,
      materialize: () => {
        const scratch = new Uint8Array(1024 * 1024);
        scratch.fill(77);
        return { instance: { scratch }, allocatedBytes: scratch.byteLength };
      },
      run: ({ runtime }) => runtime.scratch[0],
      release: ({ runtime }) => {
        assert.equal(runtime.scratch.byteLength, 1024 * 1024);
        released.push("release-proof");
      },
    },
  ]);

  const run = await executeIgnitionRun({
    registry,
    request: { kind: "release-proof" },
    mode: "ignition",
  });

  assert.deepEqual(released, ["release-proof"]);
  assert.deepEqual(run.receipt.releasedCapabilityIds, ["release-proof"]);
  assert.equal(JSON.stringify(run.receipt).includes("scratch"), false);
});
