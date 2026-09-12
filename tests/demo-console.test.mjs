import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(args, env = {}) {
  return spawnSync(process.execPath, ["scripts/package-cli.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("demo leads with human-readable equivalence and bounded allocation evidence", () => {
  const completed = run(["demo"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.match(completed.stdout, /5\/5 EXACT OUTPUT MATCHES/);
  assert.match(completed.stdout, /NUMBERS\s+EXACT\s+2\/6 bodies/);
  assert.match(completed.stdout, /HEAVY\s+EXACT\s+1\/6 bodies/);
  assert.match(completed.stdout, /Cumulative demo allocation delta: 86\.5 MiB/);
  assert.match(completed.stdout, /not OS memory, energy/);
  assert.match(completed.stdout, /Ignition should always win/);
  assert.doesNotMatch(completed.stdout, /^\{/m);
});

test("json mode preserves the five exact deterministic receipt rows", () => {
  const completed = run(["demo", "--json"]);
  assert.equal(completed.status, 0, completed.stderr);
  const rows = completed.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.scenario), ["numbers", "text", "lookup", "mixed", "heavy"]);
  assert.equal(rows.every((row) => row.equivalent), true);
  assert.deepEqual(rows.map((row) => row.resultHash), ["5d6a4a4e", "4419bcbd", "7555f107", "400adc60", "d0dff852"]);
});

test("one scenario can be inspected without changing its receipt", () => {
  const completed = run(["demo", "--scenario", "heavy", "--json"]);
  assert.equal(completed.status, 0, completed.stderr);
  const row = JSON.parse(completed.stdout);
  assert.equal(row.scenario, "heavy");
  assert.equal(row.equivalent, true);
  assert.equal(row.ignitionActualMaterializedBytes, 16 * 1024 * 1024);
  assert.equal(row.resultHash, "d0dff852");
});

test("terminal layouts stay within their declared widths", () => {
  for (const columns of [44, 56, 72, 120]) {
    const completed = run(["demo"], { COLUMNS: String(columns), NO_COLOR: "1" });
    assert.equal(completed.status, 0, completed.stderr);
    const lines = completed.stdout.trimEnd().split("\n");
    assert.equal(lines.every((line) => line.length <= columns), true, `COLUMNS=${columns}\n${completed.stdout}`);
    assert.doesNotMatch(completed.stdout, /\u001b\[/);
    if (columns < 64) assert.doesNotMatch(completed.stdout, /Route:/);
    else assert.match(completed.stdout, /Route:/);
  }
});

test("unknown scenarios fail with a bounded recovery path", () => {
  const completed = run(["demo", "--scenario", "missing"]);
  assert.equal(completed.status, 2);
  assert.match(completed.stderr, /unknown scenario: missing/);
  assert.match(completed.stderr, /Available scenarios: numbers, text, lookup, mixed, heavy/);
});
