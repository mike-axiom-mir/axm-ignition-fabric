import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, "domain-checkpoint-probe.mjs");
const samples = 5;
const scenarios = ["path-first", "path-middle", "path-last", "import-last"];
const methodsByScenario = {
  "path-first": ["none", "selective", "full"],
  "path-middle": ["none", "selective", "full"],
  "path-last": ["none", "selective", "full"],
  "import-last": ["none", "wrong", "selective", "full"],
};

function runProbe(method, scenario) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [probe, method, scenario], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`domain checkpoint probe failed: ${method}/${scenario} exit ${code}`));
      try {
        resolve(JSON.parse(stdout.trim().split("\n").at(-1)));
      } catch (error) {
        reject(new Error(`invalid domain checkpoint output: ${method}/${scenario}: ${error.message}`));
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
  for (const method of methodsByScenario[scenario]) {
    const rows = [];
    for (let i = 0; i < samples; i += 1) rows.push(await runProbe(method, scenario));
    const deterministicFields = {
      hashes: unique(rows, (row) => row.finalHash),
      sizes: unique(rows, (row) => row.finalCanonicalCharacters),
      changedDomains: unique(rows, (row) => JSON.stringify(row.changedDomains)),
      identities: unique(rows, (row) => JSON.stringify(row.domainIdentity)),
      checkpointDomains: unique(rows, (row) => JSON.stringify(row.checkpointDomains)),
      checkpointBytes: unique(rows, (row) => row.domainCheckpointBytes),
      stateCheckpointBytes: unique(rows, (row) => row.stateCheckpointBytes),
      domainChars: unique(rows, (row) => row.domainCanonicalCharactersRehashed),
      domainEntriesRehashed: unique(rows, (row) => row.domainEntriesRehashed),
      domainEntriesSkipped: unique(rows, (row) => row.domainEntriesSkipped),
      checkpointedChangedDomains: unique(rows, (row) => JSON.stringify(row.checkpointedChangedDomains)),
      fallbackChangedDomains: unique(rows, (row) => JSON.stringify(row.fallbackChangedDomains)),
      stateChars: unique(rows, (row) => row.stateFingerprintCharactersRehashed),
    };
    for (const [name, values] of Object.entries(deterministicFields)) {
      if (values.length !== 1) throw new Error(`${scenario}/${method} unstable deterministic field: ${name}`);
    }
    results[scenario][method] = {
      hash: deterministicFields.hashes[0],
      canonicalCharacters: deterministicFields.sizes[0],
      changedDomains: JSON.parse(deterministicFields.changedDomains[0]),
      domainIdentity: JSON.parse(deterministicFields.identities[0]),
      checkpointDomains: JSON.parse(deterministicFields.checkpointDomains[0]),
      domainCheckpointBytes: deterministicFields.checkpointBytes[0],
      stateCheckpointBytes: deterministicFields.stateCheckpointBytes[0],
      stateFingerprintCharactersRehashed: deterministicFields.stateChars[0],
      domainCanonicalCharactersRehashed: deterministicFields.domainChars[0],
      domainEntriesRehashed: deterministicFields.domainEntriesRehashed[0],
      domainEntriesSkipped: deterministicFields.domainEntriesSkipped[0],
      checkpointedChangedDomains: JSON.parse(deterministicFields.checkpointedChangedDomains[0]),
      fallbackChangedDomains: JSON.parse(deterministicFields.fallbackChangedDomains[0]),
      wallMs: stats(rows, (row) => row.wallMs),
    };
  }

  const baseline = results[scenario].none;
  for (const method of methodsByScenario[scenario].filter((name) => name !== "none")) {
    const candidate = results[scenario][method];
    if (candidate.hash !== baseline.hash) throw new Error(`${scenario}/${method} changed exact state hash`);
    if (candidate.canonicalCharacters !== baseline.canonicalCharacters) throw new Error(`${scenario}/${method} changed canonical size`);
    if (JSON.stringify(candidate.domainIdentity) !== JSON.stringify(baseline.domainIdentity)) throw new Error(`${scenario}/${method} changed domain identity`);
    if (JSON.stringify(candidate.changedDomains) !== JSON.stringify(baseline.changedDomains)) throw new Error(`${scenario}/${method} changed mutation-domain truth`);
    if (candidate.stateCheckpointBytes !== 10000) throw new Error(`${scenario}/${method} changed v0.20 state checkpoint body`);
    if (candidate.stateFingerprintCharactersRehashed !== baseline.stateFingerprintCharactersRehashed) {
      throw new Error(`${scenario}/${method} contaminated state fingerprint work while testing domain checkpoints`);
    }
  }
}

for (const scenario of ["path-first", "path-middle", "path-last"]) {
  if (results[scenario].selective.domainCheckpointBytes !== 10000) throw new Error(`${scenario} selective metadata checkpoint must cost 10 KB`);
  if (results[scenario].full.domainCheckpointBytes !== 70000) throw new Error(`${scenario} full domain checkpoints must cost 70 KB`);
  if (results[scenario].selective.domainCanonicalCharactersRehashed !== results[scenario].full.domainCanonicalCharactersRehashed) {
    throw new Error(`${scenario} selective metadata checkpoint should do the same changed-domain replay as full checkpoints`);
  }
}
if (results["path-first"].selective.domainEntriesSkipped !== 0) throw new Error("first-file domain checkpoint must preserve no-prefix-skip counterexample");
if (results["path-middle"].selective.domainEntriesSkipped !== 1250) throw new Error("middle metadata checkpoint must skip 1,250 entries");
if (results["path-last"].selective.domainEntriesSkipped !== 2499) throw new Error("last metadata checkpoint must skip 2,499 entries");
if (!(results["path-first"].selective.domainCanonicalCharactersRehashed > results["path-middle"].selective.domainCanonicalCharactersRehashed
  && results["path-middle"].selective.domainCanonicalCharactersRehashed > results["path-last"].selective.domainCanonicalCharactersRehashed)) {
  throw new Error("metadata domain checkpoint must expose position-sensitive suffix cost");
}

const importLast = results["import-last"];
if (importLast.wrong.domainCheckpointBytes !== 10000) throw new Error("wrong metadata checkpoint must still cost 10 KB");
if (importLast.wrong.domainCanonicalCharactersRehashed !== importLast.none.domainCanonicalCharactersRehashed) {
  throw new Error("wrong metadata checkpoint must not reduce import-domain replay");
}
if (importLast.wrong.domainEntriesSkipped !== 0) throw new Error("wrong metadata checkpoint must not skip changed-domain entries");
if (importLast.selective.domainCheckpointBytes !== 20000) throw new Error("relevant import-pair checkpoints must cost 20 KB");
if (importLast.full.domainCheckpointBytes !== 70000) throw new Error("full import checkpoints must cost 70 KB");
if (importLast.selective.domainCanonicalCharactersRehashed !== importLast.full.domainCanonicalCharactersRehashed) {
  throw new Error("20 KB import-pair checkpoints must match 70 KB full changed-domain replay");
}
if (importLast.selective.domainEntriesRehashed !== 2 || importLast.selective.domainEntriesSkipped !== 4998) {
  throw new Error("near-end two-domain mutation must rehash two entries and skip 4,998");
}

const observedDelta = {};
for (const scenario of scenarios) {
  const baseline = results[scenario].none;
  observedDelta[scenario] = {};
  for (const method of methodsByScenario[scenario].filter((name) => name !== "none")) {
    const candidate = results[scenario][method];
    const saved = baseline.domainCanonicalCharactersRehashed - candidate.domainCanonicalCharactersRehashed;
    observedDelta[scenario][method] = {
      domainCheckpointBytes: candidate.domainCheckpointBytes,
      domainCanonicalCharactersSaved: saved,
      domainCharacterFractionSaved: baseline.domainCanonicalCharactersRehashed ? saved / baseline.domainCanonicalCharactersRehashed : 0,
      domainEntriesSkipped: candidate.domainEntriesSkipped,
      timingNoneMinusCandidateMs: baseline.wallMs.median - candidate.wallMs.median,
    };
  }
}

console.log(JSON.stringify({
  schema: "axm.ignition-domain-checkpoint-comparison/v0.21",
  samples,
  fileCount: 2500,
  results,
  observedDelta,
  proofBoundary: {
    exactness: "Every domain-checkpoint policy must preserve the same legacy-compatible state hash, exact canonical size, changed-domain receipt, domain hashes, and domain revisions as the no-domain-checkpoint path.",
    isolation: "All methods retain the same 10,000-byte v0.20 state-fingerprint checkpoint body and must report identical state-fingerprint replay work; v0.21 varies only domain-hash checkpoints.",
    selectiveCost: "One selected domain costs 10,000 bytes at 2,500 files, two selected domains cost 20,000 bytes, and all seven realistic domains cost 70,000 bytes.",
    positionBoundary: "Domain FNV hashes are sequential. A checkpoint skips only the unchanged prefix before the changed entry; the changed entry and suffix remain replay work. First-file metadata mutation is retained as the no-prefix-skip counterexample.",
    wrongCheckpoint: "A metadata-only checkpoint during an import/content-hash mutation must provide zero changed-domain replay reduction while still charging its 10,000-byte persistent body.",
    timing: "Five fresh processes per method/scenario. Bootstrap/checkpoint construction and independent full-reference verification are excluded. Hosted timings are observations, not a hard CI speed invariant.",
  },
}));
