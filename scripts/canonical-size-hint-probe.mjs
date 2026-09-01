import v8 from "node:v8";
import { hashValue, hashValueMonolithic } from "../src/ignition-core.js";
import { hashValueAdaptiveWithDecision, selectAdaptiveFingerprintMode } from "../src/adaptive-fingerprint.js";
import { hashValueStreaming } from "../src/streaming-fingerprint.js";
import {
  advanceWorkspaceCanonicalSizeHint,
  canonicalStringCharacterLength,
  deriveWorkspacePointCanonicalCharacters,
  hashValueWithCanonicalSizeHint,
} from "../src/canonical-size-hint.js";
import { buildWorkspaceState } from "../src/realistic-workload.js";
import { createWorkspacePointMutationReceipt } from "../src/incremental-domain-index.js";
import { bootstrapTrackedWorkspaceTruth, applyTrackedWorkspacePointPatch } from "../src/tracked-workspace-truth.js";

const method = process.argv[2] || "v017";
const scenario = process.argv[3] || "path";
const measureMode = process.argv[4] || "timing";

if (!["v017", "hinted"].includes(method)) throw new Error("method must be v017 or hinted");
if (!["path", "same-width", "threshold"].includes(scenario)) throw new Error("scenario must be path, same-width, or threshold");
if (!["timing", "memory"].includes(measureMode)) throw new Error("measureMode must be timing or memory");
if (measureMode === "memory" && typeof global.gc !== "function") throw new Error("memory mode requires --expose-gc");

const fileCount = scenario === "threshold" ? 100 : 2500;
const iterations = scenario === "threshold" ? 1 : 8;

function makePatch(state, iteration) {
  if (scenario === "same-width") {
    const file = state.files[1];
    const from = iteration % 2 === 0 ? "file-2.js" : "file-3.js";
    const to = iteration % 2 === 0 ? "file-3.js" : "file-2.js";
    if (!file.content.includes(from)) throw new Error(`same-width fixture missing ${from}`);
    return { fileId: 1, patch: { content: file.content.replace(from, to) } };
  }
  if (scenario === "threshold") {
    const file = state.files[0];
    return { fileId: 0, patch: { content: `${file.content}${"x".repeat(20000)}` } };
  }
  const fileId = (iteration * 137) % state.files.length;
  const file = state.files[fileId];
  return { fileId, patch: { path: `${file.path}/r${iteration}` } };
}

function patchState(state, fileId, patch) {
  const fileIndex = state.files.findIndex((file) => file.id === fileId);
  if (fileIndex < 0) throw new Error(`unknown file id: ${fileId}`);
  const files = [...state.files];
  files[fileIndex] = { ...files[fileIndex], ...patch, id: files[fileIndex].id };
  return { state: { ...state, files }, fileIndex };
}

function snapshot() {
  global.gc();
  const memory = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  return {
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    v8MallocedMemory: heap.malloced_memory,
  };
}

function deltaPeak(stages, field) {
  const baseline = stages[0].memory[field];
  return Math.max(0, ...stages.map((stage) => stage.memory[field] - baseline));
}

if (measureMode === "timing") {
  const initialState = buildWorkspaceState({ fileCount });
  let state;
  let stateHash;
  let tracked;
  if (method === "hinted") {
    tracked = bootstrapTrackedWorkspaceTruth(initialState);
    state = tracked.state;
    stateHash = tracked.stateHash;
  } else {
    state = initialState;
    stateHash = hashValue(state);
  }

  const routes = [];
  let totalPreflightNodes = 0;
  let totalSizeHintFileInspections = 0;
  const started = performance.now();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const { fileId, patch } = makePatch(state, iteration);
    if (method === "hinted") {
      tracked = applyTrackedWorkspacePointPatch({ tracked, fileId, patch, evidence: { benchmark: scenario, iteration } });
      state = tracked.state;
      stateHash = tracked.stateHash;
      routes.push(tracked.lastMutation.fingerprint.mode);
      totalSizeHintFileInspections += 1;
    } else {
      const beforeState = state;
      const beforeHash = stateHash;
      const patched = patchState(state, fileId, patch);
      state = patched.state;
      const adaptive = hashValueAdaptiveWithDecision(state);
      stateHash = adaptive.hash;
      routes.push(adaptive.mode);
      totalPreflightNodes += adaptive.estimate.nodesVisited;
      createWorkspacePointMutationReceipt({
        beforeState,
        afterState: state,
        fileIndex: patched.fileIndex,
        fromStateHash: beforeHash,
        toStateHash: stateHash,
        evidence: { benchmark: scenario, iteration },
      });
    }
  }
  const wallMs = performance.now() - started;
  const canonicalCharacters = canonicalStringCharacterLength(state);
  console.log(JSON.stringify({
    schema: "axm.ignition-canonical-size-hint-probe/v0.19",
    method,
    scenario,
    measureMode,
    fileCount,
    iterations,
    finalHash: stateHash,
    finalCanonicalCharacters: canonicalCharacters,
    maintainedCanonicalCharacters: method === "hinted" ? tracked.canonicalSizeHint.canonicalCharacters : null,
    routes,
    totalPreflightNodes,
    totalSizeHintFileInspections,
    wallMs,
    timingBoundary: "Fresh Node process. Initial state construction/bootstrap is excluded. Timed v0.17 transitions include point patch + adaptive preflight/hash + mutation receipt. Timed hinted transitions include point patch + one-file exact size maintenance + exact-size route/hash + mutation receipt + size-hint receipt.",
  }));
  process.exit(0);
}

let state = buildWorkspaceState({ fileCount });
let stateHash = hashValue(state);
let tracked = method === "hinted" ? bootstrapTrackedWorkspaceTruth(state) : null;
if (tracked) {
  state = tracked.state;
  stateHash = tracked.stateHash;
}
const { fileId, patch } = makePatch(state, 0);
const beforeState = state;
const patched = patchState(state, fileId, patch);
const nextState = patched.state;
const stages = [{ name: "baseline", memory: snapshot() }];
let route;
let finalHash;
let preflightNodes = 0;
let maintainedCanonicalCharacters = null;

if (method === "v017") {
  const decision = selectAdaptiveFingerprintMode(nextState);
  route = decision.mode;
  preflightNodes = decision.estimate.nodesVisited;
  stages.push({ name: "preflight-complete", memory: snapshot() });
  finalHash = route === "streaming" ? hashValueStreaming(nextState) : hashValueMonolithic(nextState);
  stages.push({ name: "hash-complete", memory: snapshot() });
  createWorkspacePointMutationReceipt({
    beforeState,
    afterState: nextState,
    fileIndex: patched.fileIndex,
    fromStateHash: stateHash,
    toStateHash: finalHash,
    evidence: { benchmark: scenario, memory: true },
  });
  stages.push({ name: "receipt-complete", memory: snapshot() });
} else {
  const derived = deriveWorkspacePointCanonicalCharacters({
    hint: tracked.canonicalSizeHint,
    beforeState,
    afterState: nextState,
    fileIndex: patched.fileIndex,
  });
  maintainedCanonicalCharacters = derived.canonicalCharacters;
  stages.push({ name: "one-file-size-maintained", memory: snapshot() });
  const fingerprint = hashValueWithCanonicalSizeHint(nextState, derived.canonicalCharacters);
  route = fingerprint.mode;
  finalHash = fingerprint.hash;
  stages.push({ name: "hash-complete", memory: snapshot() });
  createWorkspacePointMutationReceipt({
    beforeState,
    afterState: nextState,
    fileIndex: patched.fileIndex,
    fromStateHash: stateHash,
    toStateHash: finalHash,
    evidence: {
      benchmark: scenario,
      memory: true,
      canonicalSizeHintReceiptHash: tracked.canonicalSizeHint.receiptHash,
      canonicalSizeCharactersBefore: tracked.canonicalSizeHint.canonicalCharacters,
      canonicalSizeCharactersAfter: derived.canonicalCharacters,
    },
  });
  advanceWorkspaceCanonicalSizeHint({
    hint: tracked.canonicalSizeHint,
    beforeState,
    afterState: nextState,
    fileIndex: patched.fileIndex,
    toStateHash: finalHash,
  });
  stages.push({ name: "receipts-complete", memory: snapshot() });
}

const canonicalCharacters = canonicalStringCharacterLength(nextState);
const fields = ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers", "v8MallocedMemory"];
console.log(JSON.stringify({
  schema: "axm.ignition-canonical-size-hint-probe/v0.19",
  method,
  scenario,
  measureMode,
  fileCount,
  iterations: 1,
  finalHash,
  finalCanonicalCharacters: canonicalCharacters,
  maintainedCanonicalCharacters,
  route,
  preflightNodes,
  stages,
  peakDeltaFromBaseline: Object.fromEntries(fields.map((field) => [field, deltaPeak(stages, field)])),
  measurementBoundary: "Fresh --expose-gc process. Input state and baseline fingerprint exist before baseline. Physical envelopes are observational and overlapping; exact hash, exact canonical character count, route, and preflight/file-inspection counts are deterministic contract data.",
}));
