import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, "one-truth-advance-probe.mjs");
const methods = ["v019", "v020"];
const scenarios = ["first", "middle", "last", "same-width-last"];
const samples = 5;

function runProbe(method, scenario) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [probe, method, scenario], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`one truth advance probe failed: ${method}/${scenario} exit ${code}`));
      try {
        resolve(JSON.parse(stdout.trim().split("\n").at(-1)));
      } catch (error) {
        reject(new Error(`invalid one truth advance output: ${method}/${scenario}: ${error.message}`));
      }
    });
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function stats(rows, selector) {
  const values = rows.map(selector);
  return { median: median(values), min: Math.min(...values), max: Math.max(...values) };
}

function unique(rows, selector) {
  return [...new Set(rows.map(selector))];
}

const results = {};
for (const scenario of scenarios) {
  results[scenario] = {};
  for (const method of methods) {
    const rows = [];
    for (let i = 0; i < samples; i += 1) rows.push(await runProbe(method, scenario));
    const hashes = unique(rows, (row) => row.finalHash);
    const sizes = unique(rows, (row) => row.finalCanonicalCharacters);
    const chars = unique(rows, (row) => row.fingerprintCharactersRehashed);
    const filesRehashed = unique(rows, (row) => row.fingerprintFilesRehashed);
    const filesSkipped = unique(rows, (row) => row.fingerprintFilesSkipped);
    const checkpoints = unique(rows, (row) => row.checkpointBytes);
    const domains = unique(rows, (row) => JSON.stringify(row.domainIdentity));
    const changedDomains = unique(rows, (row) => JSON.stringify(row.changedDomains));
    if ([hashes, sizes, chars, filesRehashed, filesSkipped, checkpoints, domains, changedDomains].some((values) => values.length !== 1)) {
      throw new Error(`${scenario}/${method} produced unstable deterministic contract data`);
    }
    results[scenario][method] = {
      hash: hashes[0],
      canonicalCharacters: sizes[0],
      fingerprintCharactersRehashed: chars[0],
      fingerprintFilesRehashed: filesRehashed[0],
      fingerprintFilesSkipped: filesSkipped[0],
      checkpointBytes: checkpoints[0],
      domainIdentity: JSON.parse(domains[0]),
      changedDomains: JSON.parse(changedDomains[0]),
      wallMs: stats(rows, (row) => row.wallMs),
      fingerprintMode: unique(rows, (row) => row.fingerprintMode),
      suffixStillRehashed: unique(rows, (row) => row.suffixStillRehashed ?? false),
    };
  }

  const baseline = results[scenario].v019;
  const candidate = results[scenario].v020;
  if (baseline.hash !== candidate.hash) throw new Error(`${scenario} v0.20 changed exact state hash`);
  if (baseline.canonicalCharacters !== candidate.canonicalCharacters) throw new Error(`${scenario} v0.20 changed canonical size truth`);
  if (JSON.stringify(baseline.domainIdentity) !== JSON.stringify(candidate.domainIdentity)) throw new Error(`${scenario} v0.20 changed domain identity`);
  if (JSON.stringify(baseline.changedDomains) !== JSON.stringify(candidate.changedDomains)) throw new Error(`${scenario} v0.20 changed changed-domain receipt`);
  if (candidate.checkpointBytes !== 10000) throw new Error(`${scenario} unexpected checkpoint body size`);
  if (candidate.fingerprintCharactersRehashed > baseline.fingerprintCharactersRehashed) throw new Error(`${scenario} checkpointed path rehashed more canonical characters than full fingerprint`);
}

if (results.first.v020.fingerprintFilesRehashed !== 2500) throw new Error("first-file counterexample must still rehash all file bodies");
if (results.middle.v020.fingerprintFilesRehashed !== 1250) throw new Error("middle-file checkpoint must rehash middle suffix");
if (results.last.v020.fingerprintFilesRehashed !== 1) throw new Error("last-file checkpoint must rehash one file body");
if (results["same-width-last"].v020.fingerprintFilesRehashed !== 2) throw new Error("same-width-last checkpoint must rehash two file bodies");
if (!(results.first.v020.fingerprintCharactersRehashed > results.middle.v020.fingerprintCharactersRehashed
  && results.middle.v020.fingerprintCharactersRehashed > results.last.v020.fingerprintCharactersRehashed)) {
  throw new Error("checkpointed exact FNV must expose position-sensitive suffix cost");
}
if (results["same-width-last"].v020.canonicalCharacters !== 1284856) throw new Error("same-width mutation must preserve canonical size");

const observedDelta = Object.fromEntries(scenarios.map((scenario) => {
  const baseline = results[scenario].v019;
  const candidate = results[scenario].v020;
  const savedCharacters = baseline.fingerprintCharactersRehashed - candidate.fingerprintCharactersRehashed;
  return [scenario, {
    timingV019MinusV020Ms: baseline.wallMs.median - candidate.wallMs.median,
    fingerprintCharactersSaved: savedCharacters,
    fingerprintCharacterFractionSaved: baseline.fingerprintCharactersRehashed
      ? savedCharacters / baseline.fingerprintCharactersRehashed
      : 0,
    fingerprintFilesSkipped: candidate.fingerprintFilesSkipped,
    checkpointBytes: candidate.checkpointBytes,
  }];
}));

console.log(JSON.stringify({
  schema: "axm.ignition-one-truth-advance-comparison/v0.20",
  samples,
  fileCount: 2500,
  results,
  observedDelta,
  proofBoundary: {
    exactness: "v0.19 and v0.20 must end at the same legacy-compatible FNV state hash, exact canonical size, changed-domain receipt, and versioned domain identity.",
    oneEvent: "v0.20 uses one trusted point-mutation event to advance canonical-size metadata, exact state fingerprint checkpoints, the mutation receipt, and the existing v0.10 domain identity.",
    checkpointCost: "The 2,500-file checkpoint body is a persistent 10,000-byte Uint32Array: one 32-bit FNV state per file boundary.",
    positionBoundary: "Exact FNV compatibility is sequential. Prefix checkpoints skip unchanged prefix characters, but the changed file and canonical suffix still have to be rehashed. First-file mutation is retained as the near-no-benefit counterexample.",
    timing: "Five fresh processes per method/scenario. Bootstrap/checkpoint construction and independent full-reference verification are excluded. Timing is observational and is not a hard CI speed invariant.",
    compatibility: "This does not introduce a new Merkle/state-hash identity. The external state hash remains byte-for-byte compatible with the existing canonical FNV fingerprint.",
  },
}));
