import test from "node:test";
import assert from "node:assert/strict";

import { hashValue } from "../src/ignition-core.js";
import { buildWorkspaceState, realisticRequests } from "../src/realistic-workload.js";
import { REALISTIC_DOMAIN_BINDINGS } from "../src/realistic-mutations.js";
import { StreamedWorksetSession } from "../src/streamed-workset-session.js";
import {
  buildConstructionAwareSegmentedRegistry,
  buildMetadataIndexEncoder,
  buildMetadataIndexScalar,
  utf8ByteLengthScalar,
} from "../src/construction-aware-metadata.js";

const encoder = new TextEncoder();

test("scalar UTF-8 byte length exactly matches TextEncoder across representative Unicode and malformed surrogates", () => {
  const cases = [
    "",
    "plain ascii",
    "héllo",
    "Καλημέρα",
    "こんにちは",
    "😀🔥⚙️",
    "a\u0000b",
    "\ud800",
    "\udc00",
    "x\ud800y",
    "x\udc00y",
    "\ud83d\ude00",
    "\ud83dA\ude00",
  ];
  for (const value of cases) {
    assert.equal(utf8ByteLengthScalar(value), encoder.encode(value).byteLength, JSON.stringify(value));
  }
});

test("scalar metadata body is byte-for-byte equivalent to encoder metadata body", () => {
  const state = buildWorkspaceState({ fileCount: 2500 });
  const baseline = buildMetadataIndexEncoder(state);
  const scalar = buildMetadataIndexScalar(state);
  assert.equal(scalar.allocatedBytes, baseline.allocatedBytes);
  assert.deepEqual(Array.from(scalar.instance.sizes), Array.from(baseline.instance.sizes));
  assert.deepEqual(Array.from(scalar.instance.pathHashes), Array.from(baseline.instance.pathHashes));
  assert.deepEqual(Array.from(scalar.instance.packageIds), Array.from(baseline.instance.packageIds));
  assert.deepEqual(Array.from(scalar.instance.languages), Array.from(baseline.instance.languages));
});

test("construction-aware scalar metadata preserves exact 64-segment seven-body report", async () => {
  const state = buildWorkspaceState({ fileCount: 2500 });
  const stateFingerprint = hashValue(state);
  const baseline = new StreamedWorksetSession({
    registry: buildConstructionAwareSegmentedRegistry({ segmentBits: 6, metadataMode: "encoder" }),
    maxCacheBytes: 0,
    policy: "none",
    domainBindings: REALISTIC_DOMAIN_BINDINGS,
  });
  const scalar = new StreamedWorksetSession({
    registry: buildConstructionAwareSegmentedRegistry({ segmentBits: 6, metadataMode: "scalar" }),
    maxCacheBytes: 0,
    policy: "none",
    domainBindings: REALISTIC_DOMAIN_BINDINGS,
  });
  try {
    const a = await baseline.run({ request: realisticRequests.report, state, stateFingerprint });
    const b = await scalar.run({ request: realisticRequests.report, state, stateFingerprint });
    assert.equal(a.receipt.resultHash, b.receipt.resultHash);
    assert.equal(a.receipt.resultHash, "daa06e7e");
    assert.deepEqual(b.result, a.result);
    assert.equal(
      b.receipt.materializationReceipts.find((entry) => entry.capabilityId === "workspace-metadata-index").allocatedBytes,
      a.receipt.materializationReceipts.find((entry) => entry.capabilityId === "workspace-metadata-index").allocatedBytes
    );
  } finally {
    await baseline.close({ state });
    await scalar.close({ state });
  }
});

test("metadata construction mode is explicit and rejects unknown modes", () => {
  assert.throws(
    () => buildConstructionAwareSegmentedRegistry({ segmentBits: 6, metadataMode: "magic" }),
    /metadataMode must be encoder or scalar/
  );
});
