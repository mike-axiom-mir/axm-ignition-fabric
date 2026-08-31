import { CapabilityRegistry, fnv1a32 } from "./ignition-core.js";
import { buildSegmentedRealisticRegistry } from "./segmented-search.js";

const encoder = new TextEncoder();
const LANGUAGE_CODES = new Map([["js", 1], ["json", 2], ["md", 3], ["css", 4], ["html", 5]]);

function hashInt(text) {
  return Number.parseInt(fnv1a32(text), 16) >>> 0;
}

export function utf8ByteLengthScalar(text) {
  const value = String(text);
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 3;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function buildMetadataBody(state, byteLength) {
  if (!state || !Array.isArray(state.files)) throw new Error("metadata materializer requires workspace files");
  const n = state.files.length;
  const sizes = new Uint32Array(n);
  const pathHashes = new Uint32Array(n);
  const packageIds = new Uint16Array(n);
  const languages = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const file = state.files[i];
    sizes[i] = byteLength(file.content);
    pathHashes[i] = hashInt(file.path);
    packageIds[i] = file.packageId;
    languages[i] = LANGUAGE_CODES.get(file.language) || 0;
  }
  return {
    instance: { sizes, pathHashes, packageIds, languages },
    allocatedBytes: sizes.byteLength + pathHashes.byteLength + packageIds.byteLength + languages.byteLength,
  };
}

export function buildMetadataIndexEncoder(state) {
  return buildMetadataBody(state, (text) => encoder.encode(text).byteLength);
}

export function buildMetadataIndexScalar(state) {
  return buildMetadataBody(state, utf8ByteLengthScalar);
}

export function buildConstructionAwareSegmentedRegistry({ segmentBits = 6, metadataMode = "scalar" } = {}) {
  if (!["encoder", "scalar"].includes(metadataMode)) throw new Error("metadataMode must be encoder or scalar");
  const base = buildSegmentedRealisticRegistry({ segmentBits });
  const capabilities = base.all().map((capability) => {
    if (capability.id !== "workspace-metadata-index") return { ...capability };
    return {
      ...capability,
      construction: Object.freeze({
        schema: "axm.ignition-construction-lifetime/v0.14",
        metadataMode,
        perFileArrayBufferAllocation: metadataMode === "encoder",
      }),
      materialize: ({ state }) => metadataMode === "encoder"
        ? buildMetadataIndexEncoder(state)
        : buildMetadataIndexScalar(state),
    };
  });
  return new CapabilityRegistry(capabilities);
}
