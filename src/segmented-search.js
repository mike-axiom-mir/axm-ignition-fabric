import { CapabilityRegistry, fnv1a32, hashValue } from "./ignition-core.js";
import { buildRealisticRegistry } from "./realistic-workload.js";

function hashInt(text) {
  return Number.parseInt(fnv1a32(text), 16) >>> 0;
}

function tokenize(text) {
  return text.toLowerCase().match(/[a-z_][a-z0-9_]*/g) || [];
}

function lowerBound(array, value) {
  let lo = 0;
  let hi = array.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (array[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function validateSegmentBits(segmentBits) {
  if (!Number.isInteger(segmentBits) || segmentBits < 0 || segmentBits > 16) {
    throw new Error("segmentBits must be an integer from 0 to 16");
  }
  return segmentBits;
}

export function segmentIdForHash(hash, segmentBits) {
  validateSegmentBits(segmentBits);
  const value = Number(hash) >>> 0;
  if (segmentBits === 0) return 0;
  return value >>> (32 - segmentBits);
}

export function buildSearchSegment(state, request, { segmentBits = 4 } = {}) {
  validateSegmentBits(segmentBits);
  if (!state || !Array.isArray(state.files)) throw new Error("segmented search requires workspace files");

  const query = String(request?.query || "ignite").toLowerCase();
  const queryHash = hashInt(query);
  const segmentId = segmentIdForHash(queryHash, segmentBits);
  const pairs = [];

  for (const file of state.files) {
    for (const token of tokenize(file.content)) {
      const tokenHash = hashInt(token);
      if (segmentIdForHash(tokenHash, segmentBits) === segmentId) {
        pairs.push([tokenHash, file.id]);
      }
    }
  }

  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const tokenHashes = new Uint32Array(pairs.length);
  const fileIds = new Uint32Array(pairs.length);
  for (let i = 0; i < pairs.length; i += 1) {
    tokenHashes[i] = pairs[i][0];
    fileIds[i] = pairs[i][1];
  }

  return {
    instance: {
      schema: "axm.ignition-search-segment/v0.13",
      segmentBits,
      segmentId,
      queryHash,
      tokenHashes,
      fileIds,
    },
    allocatedBytes: tokenHashes.byteLength + fileIds.byteLength,
    segmentReceipt: {
      schema: "axm.ignition-search-segment-receipt/v0.13",
      segmentBits,
      segmentId,
      queryHash,
      pairCount: pairs.length,
      allocatedBytes: tokenHashes.byteLength + fileIds.byteLength,
      sourceStateHash: hashValue(state),
    },
  };
}

export function runSearchSegment(request, runtime) {
  if (!runtime || runtime.schema !== "axm.ignition-search-segment/v0.13") {
    throw new Error("invalid segmented search runtime");
  }
  const queryHash = hashInt(String(request?.query || "ignite").toLowerCase());
  const segmentId = segmentIdForHash(queryHash, runtime.segmentBits);
  if (queryHash !== runtime.queryHash || segmentId !== runtime.segmentId) {
    throw new Error("segmented search runtime does not match request segment");
  }

  const start = lowerBound(runtime.tokenHashes, queryHash);
  let end = start;
  while (end < runtime.tokenHashes.length && runtime.tokenHashes[end] === queryHash) end += 1;
  const unique = new Set();
  for (let i = start; i < end; i += 1) unique.add(runtime.fileIds[i]);
  return { queryHash, occurrences: end - start, files: unique.size };
}

export function buildSegmentedRealisticRegistry({ segmentBits = 4 } = {}) {
  validateSegmentBits(segmentBits);
  const base = buildRealisticRegistry();
  const capabilities = base.all().map((capability) => {
    if (capability.id !== "workspace-search-index") return { ...capability };
    return {
      ...capability,
      segmentation: Object.freeze({
        schema: "axm.ignition-capability-segmentation/v0.13",
        strategy: "hash-prefix",
        segmentBits,
        retentionSafe: false,
      }),
      materialize: ({ request, state }) => buildSearchSegment(state, request, { segmentBits }),
      run: ({ request, runtime }) => runSearchSegment(request, runtime),
    };
  });
  return new CapabilityRegistry(capabilities);
}
