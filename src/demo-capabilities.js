import { CapabilityRegistry } from "./ignition-core.js";

export function buildDemoRegistry() {
  return new CapabilityRegistry([
    {
      id: "normalize-numbers",
      resourceEstimateBytes: 8_192,
      match: (request) => request.kind === "numbers" || request.kind === "mixed",
      run: ({ request }) => (request.values || []).map((value) => Math.trunc(Number(value) || 0)),
    },
    {
      id: "sum-numbers",
      dependencies: ["normalize-numbers"],
      resourceEstimateBytes: 4_096,
      match: (request) => request.kind === "numbers" || request.kind === "mixed",
      run: ({ dependencies }) => dependencies["normalize-numbers"].reduce((sum, value) => sum + value, 0),
    },
    {
      id: "tokenize-text",
      resourceEstimateBytes: 16_384,
      match: (request) => request.kind === "text" || request.kind === "mixed",
      run: ({ request }) => String(request.text || "").trim().split(/\s+/).filter(Boolean),
    },
    {
      id: "count-tokens",
      dependencies: ["tokenize-text"],
      resourceEstimateBytes: 4_096,
      match: (request) => request.kind === "text" || request.kind === "mixed",
      run: ({ dependencies }) => dependencies["tokenize-text"].length,
    },
    {
      id: "state-lookup",
      resourceEstimateBytes: 2_048,
      match: (request) => request.kind === "lookup" || request.kind === "mixed",
      run: ({ request, state }) => state[request.key] ?? null,
    },
    {
      id: "irrelevant-heavy-capability",
      resourceEstimateBytes: 1_048_576,
      match: (request) => request.kind === "heavy",
      run: () => ({ status: "materialized-only-when-requested" }),
    },
  ]);
}

export const demoRequests = {
  numbers: { kind: "numbers", values: [1.2, 2.9, 3.1, -4.8] },
  text: { kind: "text", text: "persistent truth ephemeral capability" },
  lookup: { kind: "lookup", key: "answer" },
  mixed: { kind: "mixed", values: [10, 20, 30], text: "ignite only what matters", key: "answer" },
  heavy: { kind: "heavy" },
};
