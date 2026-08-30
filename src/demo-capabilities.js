import { CapabilityRegistry } from "./ignition-core.js";

function allocationFactory(bytes, marker) {
  return () => {
    const scratch = new Uint8Array(bytes);
    scratch.fill(marker);
    return {
      instance: { scratch },
      allocatedBytes: scratch.byteLength,
    };
  };
}

function demoCapability({ id, bytes, marker, dependencies = [], match, run }) {
  return {
    id,
    dependencies,
    resourceEstimateBytes: bytes,
    materialize: allocationFactory(bytes, marker),
    match,
    run,
  };
}

export function buildDemoRegistry() {
  return new CapabilityRegistry([
    demoCapability({
      id: "normalize-numbers",
      bytes: 2 * 1024 * 1024,
      marker: 11,
      match: (request) => request.kind === "numbers" || request.kind === "mixed",
      run: ({ request, runtime }) => {
        runtime.scratch[0] ^= 1;
        return (request.values || []).map((value) => Math.trunc(Number(value) || 0));
      },
    }),
    demoCapability({
      id: "sum-numbers",
      dependencies: ["normalize-numbers"],
      bytes: 1 * 1024 * 1024,
      marker: 22,
      match: (request) => request.kind === "numbers" || request.kind === "mixed",
      run: ({ dependencies, runtime }) => {
        runtime.scratch[0] ^= 1;
        return dependencies["normalize-numbers"].reduce((sum, value) => sum + value, 0);
      },
    }),
    demoCapability({
      id: "tokenize-text",
      bytes: 3 * 1024 * 1024,
      marker: 33,
      match: (request) => request.kind === "text" || request.kind === "mixed",
      run: ({ request, runtime }) => {
        runtime.scratch[0] ^= 1;
        return String(request.text || "").trim().split(/\s+/).filter(Boolean);
      },
    }),
    demoCapability({
      id: "count-tokens",
      dependencies: ["tokenize-text"],
      bytes: 1 * 1024 * 1024,
      marker: 44,
      match: (request) => request.kind === "text" || request.kind === "mixed",
      run: ({ dependencies, runtime }) => {
        runtime.scratch[0] ^= 1;
        return dependencies["tokenize-text"].length;
      },
    }),
    demoCapability({
      id: "state-lookup",
      bytes: 512 * 1024,
      marker: 55,
      match: (request) => request.kind === "lookup" || request.kind === "mixed",
      run: ({ request, state, runtime }) => {
        runtime.scratch[0] ^= 1;
        return state[request.key] ?? null;
      },
    }),
    demoCapability({
      id: "irrelevant-heavy-capability",
      bytes: 16 * 1024 * 1024,
      marker: 66,
      match: (request) => request.kind === "heavy",
      run: ({ runtime }) => {
        runtime.scratch[0] ^= 1;
        return { status: "materialized-only-when-requested" };
      },
    }),
  ]);
}

export const demoRequests = {
  numbers: { kind: "numbers", values: [1.2, 2.9, 3.1, -4.8] },
  text: { kind: "text", text: "persistent truth ephemeral capability" },
  lookup: { kind: "lookup", key: "answer" },
  mixed: { kind: "mixed", values: [10, 20, 30], text: "ignite only what matters", key: "answer" },
  heavy: { kind: "heavy" },
};
