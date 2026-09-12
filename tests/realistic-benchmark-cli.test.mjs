import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const benchmarkPath = fileURLToPath(new URL("../scripts/run-realistic-benchmark.mjs", import.meta.url));

test("realistic benchmark CLI emits valid comparisons for savings and no-savings cases", () => {
  const stdout = execFileSync(process.execPath, [benchmarkPath, "dependencies", "report"], { encoding: "utf8" });
  const rows = stdout.trim().split(/\n+/).map((line) => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].scenario, "dependencies");
  assert.equal(rows[0].equivalent, true);
  assert.ok(rows[0].saved.actualMaterializedBytes > 0);
  assert.equal(rows[1].scenario, "report");
  assert.equal(rows[1].equivalent, true);
  assert.equal(rows[1].saved.actualMaterializedBytes, 0);
});
