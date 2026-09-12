import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildArtifacts,
  canonicalJson,
  checkArtifacts,
  REGISTRY_PATH,
  RECEIPT_PATH,
  writeArtifacts,
} from "../tools/generate-public-capabilities.mjs";

const descriptorSource = `import fs from "node:fs";\nconst packageUrl = new URL("../package.json", import.meta.url);\nexport function describeCapability() { return structuredClone(JSON.parse(fs.readFileSync(packageUrl, "utf8")).axmCapability); }\n`;

function packageDocument(overrides = {}) {
  const capability = {
    schema: "axm.capability/v1",
    id: "axm.ignition.materialization-core",
    version: "0.6.0",
    status: "EXPERIMENTAL",
    runtime: { kind: "node", minimumVersion: "18", networkRequired: false, dependencies: [] },
    entrypoints: {
      library: ".",
      command: "axm-ignition",
      discoveryCommand: "axm-ignition describe",
      demoCommand: "axm-ignition demo",
    },
    contracts: {
      runReceipt: "axm.ignition-run/v0.05",
      sessionReceipt: "axm.ignition-session-run/v0.06",
      transitionReceipt: "axm.ignition-transition/v0.06",
    },
    authority: { canonical: false, automaticMerge: false },
    ...(overrides.axmCapability ?? {}),
  };
  return {
    name: "axm-ignition-fabric",
    version: "0.0.23",
    private: true,
    type: "module",
    description: "Deterministic bounded capability materialization and state-bound session runtime.",
    license: "Apache-2.0",
    axmCapability: capability,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "axmCapability")),
  };
}

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ignition-discovery-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify(packageDocument(overrides), null, 2)}\n`);
  fs.writeFileSync(path.join(root, "src", "capability.js"), descriptorSource);
  fs.writeFileSync(path.join(root, "LICENSE"), "Apache License 2.0 fixture\n");
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test("source-backed registry preserves the package capability boundary", async () => {
  const root = fixture();
  try {
    const artifacts = await buildArtifacts(root);
    const row = JSON.parse(artifacts[REGISTRY_PATH].trim());
    const receipt = JSON.parse(artifacts[RECEIPT_PATH]);
    assert.equal(row.schema, "axm.public-capability/v1");
    assert.equal(row.id, "axm.ignition.materialization-core");
    assert.equal(row.status, "EXPERIMENTAL");
    assert.equal(row.runtime.networkRequired, false);
    assert.deepEqual(row.runtime.dependencies, []);
    assert.deepEqual(row.providers, ["mike-axiom-mir/axm-ignition-fabric"]);
    assert.equal(row.authority.execution, false);
    assert.equal(row.authority.merge, false);
    assert.equal(row.authority.canon, false);
    assert.equal(receipt.registry.capability_count, 1);
    assert.deepEqual(receipt.registry.capability_ids, [row.id]);
    assert.equal(receipt.truth_boundary.runtime_proof, false);
    assert.equal(receipt.truth_boundary.canon_authority, false);
    assert.equal(receipt.sources.length, 3);
    assert.ok(receipt.sources.every((record) => /^[0-9a-f]{40}$/.test(record.git_blob_sha1)));
  } finally {
    cleanup(root);
  }
});

test("generated outputs are deterministic and check mode detects drift without rewriting", async () => {
  const root = fixture();
  try {
    const first = await writeArtifacts(root);
    const second = await buildArtifacts(root);
    assert.deepEqual(second, first);
    assert.equal((await checkArtifacts(root)).ok, true);
    const registry = path.join(root, REGISTRY_PATH);
    fs.appendFileSync(registry, "{}\n");
    const drift = await checkArtifacts(root);
    assert.equal(drift.ok, false);
    assert.deepEqual(drift.mismatches, [REGISTRY_PATH]);
    assert.match(fs.readFileSync(registry, "utf8"), /\{\}\n$/);
  } finally {
    cleanup(root);
  }
});

test("public discovery refuses authority escalation", async () => {
  const root = fixture({ axmCapability: { authority: { canonical: true, automaticMerge: false } } });
  try {
    await assert.rejects(buildArtifacts(root), /no-CANON\/no-auto-merge/);
  } finally {
    cleanup(root);
  }
});

test("public discovery refuses a widened network contract", async () => {
  const root = fixture({
    axmCapability: {
      runtime: { kind: "node", minimumVersion: "18", networkRequired: true, dependencies: [] },
    },
  });
  try {
    await assert.rejects(buildArtifacts(root), /local\/offline runtime contract/);
  } finally {
    cleanup(root);
  }
});

test("public discovery refuses source symlink substitution", async (t) => {
  const root = fixture();
  try {
    const outside = path.join(root, "outside-capability.js");
    fs.writeFileSync(outside, descriptorSource);
    fs.unlinkSync(path.join(root, "src", "capability.js"));
    try {
      fs.symlinkSync(outside, path.join(root, "src", "capability.js"));
    } catch (error) {
      if (error?.code === "EPERM") {
        t.skip("symlink creation unavailable");
        return;
      }
      throw error;
    }
    await assert.rejects(buildArtifacts(root), /regular non-symlink file/);
  } finally {
    cleanup(root);
  }
});

test("canonical JSON identity is key-order independent", () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
});
