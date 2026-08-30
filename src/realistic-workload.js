import { CapabilityRegistry, fnv1a32 } from "./ignition-core.js";

const encoder = new TextEncoder();
const LANGUAGE_CODES = new Map([["js", 1], ["json", 2], ["md", 3], ["css", 4], ["html", 5]]);

function hashInt(text) {
  return Number.parseInt(fnv1a32(text), 16) >>> 0;
}

function bytesOf(...views) {
  return views.reduce((sum, view) => sum + (view?.byteLength || 0), 0);
}

function makeBody(instance, views) {
  return { instance, allocatedBytes: bytesOf(...views) };
}

function deterministicSource(i, fileCount) {
  if (i % 113 === 0) {
    return "export const shared_duplicate = 42;\n// TODO deterministic duplicate fixture\n";
  }
  const nextA = (i + 1) % fileCount;
  const nextB = (i + 7) % fileCount;
  const nextC = (i + 31) % fileCount;
  const marker = i % 19 === 0 ? "// TODO inspect deterministic seam\n" : "";
  return [
    `import { symbol_${nextA}_0 } from \"./file-${nextA}.js\";`,
    `import { symbol_${nextB}_0 } from \"./file-${nextB}.js\";`,
    `import { symbol_${nextC}_0 } from \"./file-${nextC}.js\";`,
    `export const symbol_${i}_0 = ${i};`,
    `export const symbol_${i}_1 = symbol_${nextA}_0 + ${i % 97};`,
    `export const symbol_${i}_2 = \"ignite dormant capability truth merge receipt workspace index deterministic module ${i % 41}\";`,
    marker,
    `export function work_${i}(value) { return value + symbol_${i}_1; }`,
  ].join("\n");
}

export function buildWorkspaceState({ fileCount = 2500, packageCount = 25 } = {}) {
  const files = [];
  for (let i = 0; i < fileCount; i += 1) {
    const packageId = i % packageCount;
    const language = "js";
    files.push({
      id: i,
      packageId,
      language,
      path: `packages/p${packageId}/src/file-${i}.js`,
      content: deterministicSource(i, fileCount),
    });
  }
  return {
    schema: "axm.ignition-workspace-fixture/v0.03",
    fileCount,
    packageCount,
    files,
  };
}

function buildMetadataIndex(state) {
  const n = state.files.length;
  const sizes = new Uint32Array(n);
  const pathHashes = new Uint32Array(n);
  const packageIds = new Uint16Array(n);
  const languages = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const file = state.files[i];
    sizes[i] = encoder.encode(file.content).byteLength;
    pathHashes[i] = hashInt(file.path);
    packageIds[i] = file.packageId;
    languages[i] = LANGUAGE_CODES.get(file.language) || 0;
  }
  return makeBody({ sizes, pathHashes, packageIds, languages }, [sizes, pathHashes, packageIds, languages]);
}

function buildDependencyIndex(state) {
  const offsets = new Uint32Array(state.files.length + 1);
  const targets = [];
  const importPattern = /file-(\d+)\.js/g;
  for (let i = 0; i < state.files.length; i += 1) {
    offsets[i] = targets.length;
    importPattern.lastIndex = 0;
    let match;
    while ((match = importPattern.exec(state.files[i].content))) {
      targets.push(Number(match[1]));
    }
  }
  offsets[state.files.length] = targets.length;
  const targetIds = Uint32Array.from(targets);
  return makeBody({ offsets, targetIds }, [offsets, targetIds]);
}

function buildSymbolIndex(state) {
  const offsets = new Uint32Array(state.files.length + 1);
  const hashes = [];
  const symbolPattern = /export const ([A-Za-z0-9_]+)/g;
  for (let i = 0; i < state.files.length; i += 1) {
    offsets[i] = hashes.length;
    symbolPattern.lastIndex = 0;
    let match;
    while ((match = symbolPattern.exec(state.files[i].content))) hashes.push(hashInt(match[1]));
  }
  offsets[state.files.length] = hashes.length;
  const symbolHashes = Uint32Array.from(hashes);
  return makeBody({ offsets, symbolHashes }, [offsets, symbolHashes]);
}

function tokenize(text) {
  return text.toLowerCase().match(/[a-z_][a-z0-9_]*/g) || [];
}

function buildSearchIndex(state) {
  const pairs = [];
  for (const file of state.files) {
    for (const token of tokenize(file.content)) pairs.push([hashInt(token), file.id]);
  }
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const tokenHashes = new Uint32Array(pairs.length);
  const fileIds = new Uint32Array(pairs.length);
  for (let i = 0; i < pairs.length; i += 1) {
    tokenHashes[i] = pairs[i][0];
    fileIds[i] = pairs[i][1];
  }
  return makeBody({ tokenHashes, fileIds }, [tokenHashes, fileIds]);
}

function buildDuplicateIndex(state) {
  const contentHashes = new Uint32Array(state.files.length);
  for (let i = 0; i < state.files.length; i += 1) contentHashes[i] = hashInt(state.files[i].content);
  return makeBody({ contentHashes }, [contentHashes]);
}

function buildLintIndex(state) {
  const flags = new Uint8Array(state.files.length);
  for (let i = 0; i < state.files.length; i += 1) {
    const source = state.files[i].content;
    flags[i] = source.includes("TODO") ? 1 : source.includes("FIXME") ? 2 : 0;
  }
  return makeBody({ flags }, [flags]);
}

function buildReportProjection(state) {
  const risk = new Uint16Array(state.files.length);
  for (let i = 0; i < state.files.length; i += 1) {
    const file = state.files[i];
    risk[i] = Math.min(65535, Math.floor(file.content.length / 16) + (file.content.includes("TODO") ? 100 : 0));
  }
  return makeBody({ risk }, [risk]);
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

export function buildRealisticRegistry() {
  return new CapabilityRegistry([
    {
      id: "workspace-metadata-index",
      match: (request) => request.kind === "metadata" || request.kind === "report",
      materialize: ({ state }) => buildMetadataIndex(state),
      run: ({ state, runtime }) => ({
        files: state.files.length,
        bytes: runtime.sizes.reduce((sum, value) => sum + value, 0),
        packages: state.packageCount,
      }),
    },
    {
      id: "workspace-dependency-index",
      match: (request) => request.kind === "dependencies" || request.kind === "report",
      materialize: ({ state }) => buildDependencyIndex(state),
      run: ({ request, runtime }) => {
        const fileId = Number.isInteger(request.fileId) ? request.fileId : 0;
        const start = runtime.offsets[fileId] || 0;
        const end = runtime.offsets[fileId + 1] || start;
        return {
          edgeCount: runtime.targetIds.length,
          fileId,
          targets: Array.from(runtime.targetIds.slice(start, end)),
        };
      },
    },
    {
      id: "workspace-symbol-index",
      match: (request) => request.kind === "symbols" || request.kind === "report",
      materialize: ({ state }) => buildSymbolIndex(state),
      run: ({ request, runtime }) => {
        const fileId = Number.isInteger(request.fileId) ? request.fileId : 0;
        const start = runtime.offsets[fileId] || 0;
        const end = runtime.offsets[fileId + 1] || start;
        return { symbolCount: runtime.symbolHashes.length, fileSymbols: end - start };
      },
    },
    {
      id: "workspace-search-index",
      match: (request) => request.kind === "search" || request.kind === "report",
      materialize: ({ state }) => buildSearchIndex(state),
      run: ({ request, runtime }) => {
        const queryHash = hashInt(String(request.query || "ignite").toLowerCase());
        const start = lowerBound(runtime.tokenHashes, queryHash);
        let end = start;
        while (end < runtime.tokenHashes.length && runtime.tokenHashes[end] === queryHash) end += 1;
        const unique = new Set();
        for (let i = start; i < end; i += 1) unique.add(runtime.fileIds[i]);
        return { queryHash, occurrences: end - start, files: unique.size };
      },
    },
    {
      id: "workspace-duplicate-index",
      match: (request) => request.kind === "duplicates" || request.kind === "report",
      materialize: ({ state }) => buildDuplicateIndex(state),
      run: ({ runtime }) => {
        const counts = new Map();
        for (const hash of runtime.contentHashes) counts.set(hash, (counts.get(hash) || 0) + 1);
        let duplicateGroups = 0;
        let duplicateFiles = 0;
        for (const count of counts.values()) {
          if (count > 1) {
            duplicateGroups += 1;
            duplicateFiles += count;
          }
        }
        return { duplicateGroups, duplicateFiles };
      },
    },
    {
      id: "workspace-lint-index",
      match: (request) => request.kind === "lint" || request.kind === "report",
      materialize: ({ state }) => buildLintIndex(state),
      run: ({ runtime }) => ({ flaggedFiles: runtime.flags.reduce((sum, value) => sum + (value ? 1 : 0), 0) }),
    },
    {
      id: "workspace-report-projection",
      dependencies: [
        "workspace-dependency-index",
        "workspace-duplicate-index",
        "workspace-lint-index",
        "workspace-metadata-index",
        "workspace-search-index",
        "workspace-symbol-index",
      ],
      match: (request) => request.kind === "report",
      materialize: ({ state }) => buildReportProjection(state),
      run: ({ dependencies, runtime }) => ({
        files: dependencies["workspace-metadata-index"].files,
        edges: dependencies["workspace-dependency-index"].edgeCount,
        symbols: dependencies["workspace-symbol-index"].symbolCount,
        searchOccurrences: dependencies["workspace-search-index"].occurrences,
        duplicateFiles: dependencies["workspace-duplicate-index"].duplicateFiles,
        flaggedFiles: dependencies["workspace-lint-index"].flaggedFiles,
        riskTotal: runtime.risk.reduce((sum, value) => sum + value, 0),
      }),
    },
  ]);
}

export const realisticRequests = {
  dependencies: { kind: "dependencies", fileId: 417 },
  symbols: { kind: "symbols", fileId: 991 },
  search: { kind: "search", query: "ignite" },
  duplicates: { kind: "duplicates" },
  lint: { kind: "lint" },
  report: { kind: "report", query: "deterministic", fileId: 12 },
};
