import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPOSITORY = "mike-axiom-mir/axm-ignition-fabric";
export const DISCOVERY_BUDDY_REF = "1a94fc2481d1cfc9234dea7c86af4777126d3924";
export const REGISTRY_PATH = "registry/capabilities.jsonl";
export const RECEIPT_PATH = "registry/capabilities.receipt.json";
export const MARKER_PATH = ".axm/discovery-public.json";

const SOURCE_PATHS = ["package.json", "src/capability.js", "LICENSE"];

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitBlobSha1(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`, "utf8");
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

function resolveRegularFile(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (!resolved.startsWith(prefix)) throw new Error(`unsafe source path: ${relativePath}`);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`source must be a regular non-symlink file: ${relativePath}`);
  return { path: resolved, stat };
}

function sourceRecord(root, relativePath) {
  const resolved = resolveRegularFile(root, relativePath);
  const bytes = fs.readFileSync(resolved.path);
  return {
    path: relativePath,
    bytes: bytes.length,
    git_blob_sha1: gitBlobSha1(bytes),
  };
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function assertCapabilityBoundary(packageDocument) {
  if (packageDocument.name !== "axm-ignition-fabric") throw new Error("unexpected package name");
  if (packageDocument.private !== true) throw new Error("package must remain private to prevent accidental registry publication");
  if (packageDocument.license !== "Apache-2.0") throw new Error("unexpected package license declaration");
  const capability = packageDocument.axmCapability;
  if (!capability || capability.schema !== "axm.capability/v1") throw new Error("axmCapability schema is missing or incompatible");
  if (capability.id !== "axm.ignition.materialization-core") throw new Error("unexpected capability id");
  requireString(capability.version, "capability version");
  if (capability.status !== "EXPERIMENTAL") throw new Error("public discovery must preserve EXPERIMENTAL status");
  const runtime = capability.runtime;
  if (!runtime || runtime.kind !== "node" || runtime.minimumVersion !== "18") throw new Error("unexpected runtime boundary");
  if (runtime.networkRequired !== false) throw new Error("discovery cannot widen the local/offline runtime contract");
  if (!Array.isArray(runtime.dependencies) || runtime.dependencies.length !== 0) throw new Error("unexpected runtime dependencies");
  const authority = capability.authority;
  if (!authority || authority.canonical !== false || authority.automaticMerge !== false) {
    throw new Error("capability metadata must retain explicit no-CANON/no-auto-merge authority");
  }
  for (const [name, value] of Object.entries(capability.entrypoints ?? {})) requireString(value, `entrypoint ${name}`);
  for (const [name, value] of Object.entries(capability.contracts ?? {})) requireString(value, `contract ${name}`);
  return capability;
}

async function loadExecutableDescriptor(root, sourceIdentity) {
  const modulePath = resolveRegularFile(root, "src/capability.js").path;
  const moduleUrl = `${pathToFileURL(modulePath).href}?source=${sourceIdentity.git_blob_sha1}`;
  const module = await import(moduleUrl);
  if (typeof module.describeCapability !== "function") throw new Error("src/capability.js must export describeCapability()");
  return module.describeCapability();
}

export async function buildArtifacts(root = process.cwd()) {
  const packageFile = resolveRegularFile(root, "package.json").path;
  const packageDocument = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  const capability = assertCapabilityBoundary(packageDocument);
  const sources = SOURCE_PATHS.map((relativePath) => sourceRecord(root, relativePath));
  const capabilitySource = sources.find((record) => record.path === "src/capability.js");
  const executableDescriptor = await loadExecutableDescriptor(root, capabilitySource);
  if (canonicalJson(executableDescriptor) !== canonicalJson(capability)) {
    throw new Error("executable capability descriptor drifted from package axmCapability metadata");
  }

  const registryRecord = {
    schema: "axm.public-capability/v1",
    id: capability.id,
    version: capability.version,
    status: capability.status,
    providers: [REPOSITORY],
    consumers: [],
    summary: packageDocument.description,
    license: packageDocument.license,
    runtime: capability.runtime,
    entrypoints: capability.entrypoints,
    contracts: capability.contracts,
    source: {
      metadata: "package.json",
      descriptor: "src/capability.js",
      license: "LICENSE",
    },
    authority: {
      discoveryOnly: true,
      execution: false,
      automaticSelection: false,
      automaticInstall: false,
      merge: false,
      canon: false,
    },
  };
  const registryText = `${canonicalJson(registryRecord)}\n`;

  const receiptBody = {
    schema: "axm.public-capability-registry-receipt/v1",
    repository: REPOSITORY,
    registry: {
      path: REGISTRY_PATH,
      bytes: Buffer.byteLength(registryText),
      sha256: sha256(Buffer.from(registryText, "utf8")),
      capability_count: 1,
      capability_ids: [capability.id],
    },
    sources,
    compatibility: {
      consumer: "mike-axiom-mir/axm-discovery-buddy",
      pinned_ref: DISCOVERY_BUDDY_REF,
      marker_contract: "axm.discovery-public/v1",
      registry_contract: "registry/*capabilit*.jsonl",
    },
    truth_boundary: {
      source_backed: true,
      public_export_intent: true,
      runtime_proof: false,
      execution_authority: false,
      automatic_selection_authority: false,
      automatic_install_authority: false,
      merge_authority: false,
      canon_authority: false,
    },
  };
  const receipt = {
    ...receiptBody,
    receipt_sha256: sha256(Buffer.from(canonicalJson(receiptBody), "utf8")),
  };
  const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;

  return {
    [REGISTRY_PATH]: registryText,
    [RECEIPT_PATH]: receiptText,
  };
}

export async function checkArtifacts(root = process.cwd()) {
  const expected = await buildArtifacts(root);
  const mismatches = [];
  for (const [relativePath, text] of Object.entries(expected)) {
    const target = path.join(root, relativePath);
    let actual = null;
    try {
      actual = fs.readFileSync(target, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (actual !== text) mismatches.push(relativePath);
  }
  return { ok: mismatches.length === 0, mismatches, expected };
}

export async function writeArtifacts(root = process.cwd()) {
  const artifacts = await buildArtifacts(root);
  for (const [relativePath, text] of Object.entries(artifacts)) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, "utf8");
  }
  return artifacts;
}

async function main(argv = process.argv.slice(2)) {
  let mode = "write";
  let root = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") mode = "check";
    else if (arg === "--write") mode = "write";
    else if (arg === "--root") {
      root = path.resolve(argv[index + 1] ?? "");
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (mode === "check") {
    const result = await checkArtifacts(root);
    if (!result.ok) {
      console.error(`public capability registry is stale: ${result.mismatches.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    console.log(`public capability registry: PASS (${Object.keys(result.expected).length} generated files)`);
    return;
  }
  const artifacts = await writeArtifacts(root);
  console.log(`public capability registry: wrote ${Object.keys(artifacts).join(", ")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`public capability registry: ERROR: ${error.message}`);
    process.exitCode = 2;
  });
}
