import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, cwd = root) {
  const completed = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" }
  });
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  return completed;
}

test("local tarball exposes the bounded Ignition core to an offline consumer", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "axm-ignition-consumer-"));
  const packed = JSON.parse(run("npm", [
    "pack", "--json", "--ignore-scripts", "--pack-destination", temp
  ]).stdout)[0];
  const files = packed.files.map((entry) => entry.path);

  assert.ok(packed.size < 100_000, `package is unexpectedly large: ${packed.size}`);
  assert.ok(files.includes("src/index.js"));
  assert.ok(files.includes("src/ignition-core.js"));
  assert.ok(files.includes("src/ignition-session.js"));
  assert.ok(files.includes("scripts/package-cli.mjs"));
  assert.ok(files.includes("CONSUMER.md"));
  assert.equal(files.some((name) => name.startsWith("tests/")), false);
  assert.equal(files.some((name) => name.startsWith("evidence/")), false);
  assert.equal(files.some((name) => name.startsWith("docs/")), false);

  const consumer = path.join(temp, "consumer");
  run("npm", [
    "install", "--offline", "--ignore-scripts", "--prefix", consumer,
    path.join(temp, packed.filename)
  ]);

  const imported = run(process.execPath, [
    "--input-type=module",
    "-e",
    [
      "import { CapabilityRegistry, executeIgnitionRun, describeCapability, createTransitionReceipt } from 'axm-ignition-fabric';",
      "const registry = new CapabilityRegistry([{ id: 'double', match: r => r.kind === 'number', run: ({ request }) => request.value * 2 }]);",
      "const run = await executeIgnitionRun({ registry, request: { kind: 'number', value: 21 }, state: {}, mode: 'ignition' });",
      "let emptyDomainsRejected = false;",
      "try { createTransitionReceipt({ fromStateHash: 'a', toStateHash: 'b', changedDomains: [] }); } catch { emptyDomainsRejected = true; }",
      "process.stdout.write(JSON.stringify({ result: run.result.double, id: describeCapability().id, emptyDomainsRejected }));"
    ].join("\n")
  ], consumer);
  assert.deepEqual(JSON.parse(imported.stdout), {
    result: 42,
    id: "axm.ignition.materialization-core",
    emptyDomainsRejected: true
  });

  const command = path.join(consumer, "node_modules", ".bin", "axm-ignition");
  const described = JSON.parse(run(command, ["describe"], consumer).stdout);
  assert.equal(described.capability.contracts.transitionReceipt, "axm.ignition-transition/v0.06");

  const humanDemo = run(command, ["demo"], consumer);
  assert.match(humanDemo.stdout, /5\/5 EXACT OUTPUT MATCHES/);
  assert.match(humanDemo.stdout, /BOUNDARY/);
  assert.match(humanDemo.stdout, /--json/);

  const demo = run(command, ["demo", "--json"], consumer);
  const rows = demo.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 5);
  assert.equal(rows.every((row) => row.equivalent === true), true);
});
