import { stableStringify } from "./canonical-fingerprint-primitives.js";
import { hashValue } from "./ignition-core.js";
import { createVersionedDomainIdentity, validateDomainIdentity } from "./domain-identity.js";
import { validateWorkspacePointMutationReceipt } from "./incremental-domain-index.js";
import { REALISTIC_DOMAINS, workspaceFileDomainEntries } from "./realistic-mutations.js";

const FNV1A32_OFFSET = 0x811c9dc5;
const FNV1A32_PRIME = 0x01000193;

export const WORKSPACE_DOMAIN_HASH_CHECKPOINT_SCHEMA = "axm.ignition-workspace-domain-hash-checkpoints/v0.21";

function advanceFNV(hash, text) {
  const value = String(text);
  let next = hash >>> 0;
  for (let i = 0; i < value.length; i += 1) {
    next ^= value.charCodeAt(i);
    next = Math.imul(next, FNV1A32_PRIME) >>> 0;
  }
  return next >>> 0;
}

function digestFNV(hash) {
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stablePart(value) {
  const serialized = stableStringify(value);
  return serialized === undefined ? "undefined" : String(serialized);
}

function normalizedCheckpointDomains(domains) {
  const selected = [...new Set(domains || [])];
  for (const domain of selected) {
    if (!REALISTIC_DOMAINS.includes(domain)) throw new Error(`unknown checkpoint domain: ${domain}`);
  }
  return REALISTIC_DOMAINS.filter((domain) => selected.includes(domain));
}

function domainEnvelope(domain, fileCount) {
  return {
    prefix: `{"domain":${stablePart(domain)},"entries":[`,
    suffix: `],"fileCount":${stablePart(fileCount)}}`,
  };
}

function fullDomainHash(domain, fileCount, entries) {
  return hashValue({ domain, fileCount, entries });
}

function fullDomainCanonicalCharacters(domain, fileCount, entries) {
  return stableStringify({ domain, fileCount, entries }).length;
}

function validateIndex(index) {
  if (!index || index.schema !== "axm.ignition-workspace-domain-index/v0.10") throw new Error("invalid workspace domain index schema");
  if (!Number.isSafeInteger(index.fileCount) || index.fileCount < 0) throw new Error("invalid workspace domain index fileCount");
  validateDomainIdentity(index.identity);
  for (const domain of REALISTIC_DOMAINS) {
    if (!Array.isArray(index.entriesByDomain?.[domain]) || index.entriesByDomain[domain].length !== index.fileCount) {
      throw new Error(`invalid workspace domain entries: ${domain}`);
    }
  }
  return true;
}

function buildDomainCheckpointRecord(domain, fileCount, entries) {
  if (!Array.isArray(entries) || entries.length !== fileCount) throw new Error(`invalid checkpoint entries: ${domain}`);
  const { prefix, suffix } = domainEnvelope(domain, fileCount);
  const checkpoints = new Uint32Array(fileCount);
  let hash = advanceFNV(FNV1A32_OFFSET, prefix);
  let canonicalCharactersHashed = prefix.length;

  for (let i = 0; i < fileCount; i += 1) {
    if (i > 0) {
      hash = advanceFNV(hash, ",");
      canonicalCharactersHashed += 1;
    }
    checkpoints[i] = hash >>> 0;
    const text = stablePart(entries[i]);
    hash = advanceFNV(hash, text);
    canonicalCharactersHashed += text.length;
  }

  hash = advanceFNV(hash, suffix);
  canonicalCharactersHashed += suffix.length;
  return Object.freeze({
    domain,
    hash: digestFNV(hash),
    checkpoints,
    prefix,
    suffix,
    canonicalCharactersHashed,
  });
}

function advanceDomainCheckpointRecord(record, { fileCount, nextEntries, fileIndex }) {
  const nextCheckpoints = new Uint32Array(fileCount);
  nextCheckpoints.set(record.checkpoints.subarray(0, fileIndex + 1), 0);
  let hash = record.checkpoints[fileIndex] >>> 0;
  let canonicalCharactersRehashed = 0;
  let entriesRehashed = 0;

  const changedText = stablePart(nextEntries[fileIndex]);
  hash = advanceFNV(hash, changedText);
  canonicalCharactersRehashed += changedText.length;
  entriesRehashed += 1;

  for (let i = fileIndex + 1; i < fileCount; i += 1) {
    hash = advanceFNV(hash, ",");
    canonicalCharactersRehashed += 1;
    nextCheckpoints[i] = hash >>> 0;
    const text = stablePart(nextEntries[i]);
    hash = advanceFNV(hash, text);
    canonicalCharactersRehashed += text.length;
    entriesRehashed += 1;
  }

  hash = advanceFNV(hash, record.suffix);
  canonicalCharactersRehashed += record.suffix.length;
  return {
    record: Object.freeze({
      ...record,
      hash: digestFNV(hash),
      checkpoints: nextCheckpoints,
      canonicalCharactersHashed: record.canonicalCharactersHashed,
    }),
    metrics: Object.freeze({
      domain: record.domain,
      mode: "checkpointed-domain-suffix-rehash",
      entriesRehashed,
      entriesSkipped: fileIndex,
      canonicalCharactersRehashed,
      checkpointBytes: nextCheckpoints.byteLength,
      exactCompatibility: true,
      suffixStillRehashed: true,
    }),
  };
}

export class WorkspaceDomainHashCheckpoints {
  #records;

  constructor({ stateHash, fileCount, selectedDomains, records, generation = 0, lastAdvance = null }) {
    if (typeof stateHash !== "string" || !stateHash) throw new Error("domain checkpoint set requires stateHash");
    if (!Number.isSafeInteger(fileCount) || fileCount < 0) throw new Error("domain checkpoint set requires valid fileCount");
    const normalized = normalizedCheckpointDomains(selectedDomains);
    if (!(records instanceof Map)) throw new Error("domain checkpoint set requires records map");
    for (const domain of normalized) {
      const record = records.get(domain);
      if (!record || !(record.checkpoints instanceof Uint32Array) || record.checkpoints.length !== fileCount) {
        throw new Error(`invalid domain checkpoint record: ${domain}`);
      }
    }
    this.schema = WORKSPACE_DOMAIN_HASH_CHECKPOINT_SCHEMA;
    this.stateHash = stateHash;
    this.fileCount = fileCount;
    this.selectedDomains = Object.freeze(normalized);
    this.generation = generation;
    this.checkpointBytes = normalized.reduce((sum, domain) => sum + records.get(domain).checkpoints.byteLength, 0);
    this.lastAdvance = lastAdvance ? Object.freeze({ ...lastAdvance }) : null;
    this.#records = records;
    Object.freeze(this);
  }

  hasDomain(domain) {
    return this.#records.has(domain);
  }

  domainHash(domain) {
    const record = this.#records.get(domain);
    if (!record) throw new Error(`domain checkpoint not selected: ${domain}`);
    return record.hash;
  }

  sharesDomainCheckpointStorage(other, domain) {
    if (!(other instanceof WorkspaceDomainHashCheckpoints)) return false;
    const own = this.#records.get(domain);
    const candidate = other.#records.get(domain);
    return Boolean(own && candidate && own.checkpoints === candidate.checkpoints);
  }

  migrateSelection(index, { domains = [] } = {}) {
    validateIndex(index);
    if (this.stateHash !== index.identity.stateHash) throw new Error("domain checkpoint migration stateHash mismatch");
    if (this.fileCount !== index.fileCount) throw new Error("domain checkpoint migration fileCount mismatch");

    const selectedDomains = normalizedCheckpointDomains(domains);
    const beforeDomains = [...this.selectedDomains];
    const addedDomains = selectedDomains.filter((domain) => !this.#records.has(domain));
    const evictedDomains = beforeDomains.filter((domain) => !selectedDomains.includes(domain));
    const retainedDomains = selectedDomains.filter((domain) => this.#records.has(domain));
    const nextRecords = new Map();
    const buildCanonicalCharactersByDomain = {};

    for (const domain of retainedDomains) {
      const record = this.#records.get(domain);
      if (record.hash !== index.identity.domains[domain].hash) {
        throw new Error(`retained domain checkpoint hash mismatch: ${domain}`);
      }
      nextRecords.set(domain, record);
    }

    for (const domain of addedDomains) {
      const record = buildDomainCheckpointRecord(domain, index.fileCount, index.entriesByDomain[domain]);
      if (record.hash !== index.identity.domains[domain].hash) {
        throw new Error(`domain checkpoint migration bootstrap hash mismatch: ${domain}`);
      }
      nextRecords.set(domain, record);
      buildCanonicalCharactersByDomain[domain] = record.canonicalCharactersHashed;
    }

    const bytesPerDomain = index.fileCount * 4;
    const beforeBytes = this.checkpointBytes;
    const afterBytes = selectedDomains.length * bytesPerDomain;
    const bytesBuilt = addedDomains.length * bytesPerDomain;
    const bytesEvicted = evictedDomains.length * bytesPerDomain;
    const bytesRetained = retainedDomains.length * bytesPerDomain;
    const buildCanonicalCharacters = Object.values(buildCanonicalCharactersByDomain).reduce((sum, value) => sum + value, 0);
    const checkpointSet = new WorkspaceDomainHashCheckpoints({
      stateHash: index.identity.stateHash,
      fileCount: index.fileCount,
      selectedDomains,
      records: nextRecords,
      generation: this.generation,
      lastAdvance: {
        mode: "retained-domain-checkpoint-migration",
        beforeDomains: Object.freeze(beforeDomains),
        afterDomains: Object.freeze([...selectedDomains]),
        addedDomains: Object.freeze(addedDomains),
        evictedDomains: Object.freeze(evictedDomains),
        retainedDomains: Object.freeze(retainedDomains),
        beforeBytes,
        afterBytes,
        bytesBuilt,
        bytesEvicted,
        bytesRetained,
      },
    });
    const retainedCheckpointArraysReused = retainedDomains.every(
      (domain) => checkpointSet.sharesDomainCheckpointStorage(this, domain),
    );
    if (!retainedCheckpointArraysReused) throw new Error("retained domain checkpoint storage was rebuilt");

    return Object.freeze({
      checkpointSet,
      metrics: Object.freeze({
        mode: "checkpoint-selection-migration",
        beforeDomains: Object.freeze(beforeDomains),
        afterDomains: Object.freeze([...selectedDomains]),
        addedDomains: Object.freeze(addedDomains),
        evictedDomains: Object.freeze(evictedDomains),
        retainedDomains: Object.freeze(retainedDomains),
        beforeBytes,
        afterBytes,
        bytesBuilt,
        bytesEvicted,
        bytesRetained,
        buildCanonicalCharacters,
        buildCanonicalCharactersByDomain: Object.freeze({ ...buildCanonicalCharactersByDomain }),
        rebuildsRetainedDomains: false,
        retainedCheckpointArraysReused,
      }),
    });
  }

  advanceChangedDomains({ changedDomains, nextEntriesByDomain, fileIndex, toStateHash }) {
    if (typeof toStateHash !== "string" || !toStateHash) throw new Error("domain checkpoint advance requires toStateHash");
    const changed = [...new Set(changedDomains || [])];
    const nextRecords = new Map(this.#records);
    const hashes = {};
    const metricsByDomain = {};

    for (const domain of changed) {
      if (!this.#records.has(domain)) continue;
      const nextEntries = nextEntriesByDomain[domain];
      const advanced = advanceDomainCheckpointRecord(this.#records.get(domain), {
        fileCount: this.fileCount,
        nextEntries,
        fileIndex,
      });
      nextRecords.set(domain, advanced.record);
      hashes[domain] = advanced.record.hash;
      metricsByDomain[domain] = advanced.metrics;
    }

    const checkpointedChangedDomains = changed.filter((domain) => this.#records.has(domain));
    const lastAdvance = Object.freeze({
      mode: "selective-domain-checkpoint-advance",
      fileIndex,
      checkpointedChangedDomains: Object.freeze(checkpointedChangedDomains),
      changedDomainsWithoutCheckpoint: Object.freeze(changed.filter((domain) => !this.#records.has(domain))),
      checkpointBytes: this.checkpointBytes,
      metricsByDomain: Object.freeze(metricsByDomain),
      totalCanonicalCharactersRehashed: checkpointedChangedDomains.reduce(
        (sum, domain) => sum + metricsByDomain[domain].canonicalCharactersRehashed,
        0,
      ),
      totalEntriesRehashed: checkpointedChangedDomains.reduce((sum, domain) => sum + metricsByDomain[domain].entriesRehashed, 0),
      totalEntriesSkipped: checkpointedChangedDomains.reduce((sum, domain) => sum + metricsByDomain[domain].entriesSkipped, 0),
    });

    return Object.freeze({
      checkpointSet: new WorkspaceDomainHashCheckpoints({
        stateHash: toStateHash,
        fileCount: this.fileCount,
        selectedDomains: this.selectedDomains,
        records: nextRecords,
        generation: this.generation + 1,
        lastAdvance,
      }),
      hashes: Object.freeze(hashes),
      metrics: lastAdvance,
    });
  }
}

export function buildWorkspaceDomainHashCheckpoints(index, { domains = [] } = {}) {
  validateIndex(index);
  const selectedDomains = normalizedCheckpointDomains(domains);
  const records = new Map();
  for (const domain of selectedDomains) {
    const record = buildDomainCheckpointRecord(domain, index.fileCount, index.entriesByDomain[domain]);
    if (record.hash !== index.identity.domains[domain].hash) {
      throw new Error(`domain checkpoint bootstrap hash mismatch: ${domain}`);
    }
    records.set(domain, record);
  }
  return new WorkspaceDomainHashCheckpoints({
    stateHash: index.identity.stateHash,
    fileCount: index.fileCount,
    selectedDomains,
    records,
    generation: 0,
    lastAdvance: {
      mode: "full-domain-checkpoint-bootstrap",
      checkpointedDomains: Object.freeze([...selectedDomains]),
      checkpointBytes: selectedDomains.length * index.fileCount * 4,
    },
  });
}

export function migrateWorkspaceDomainHashCheckpointSelection(index, checkpointSet, { domains = [] } = {}) {
  validateIndex(index);
  if (!(checkpointSet instanceof WorkspaceDomainHashCheckpoints)) {
    throw new Error("domain checkpoint migration requires checkpoint set");
  }
  return checkpointSet.migrateSelection(index, { domains });
}

export function applyWorkspacePointMutationWithDomainCheckpoints({ index, checkpointSet, mutationReceipt, nextState }) {
  validateIndex(index);
  if (!(checkpointSet instanceof WorkspaceDomainHashCheckpoints)) throw new Error("domain checkpoint advance requires checkpoint set");
  if (checkpointSet.stateHash !== index.identity.stateHash) throw new Error("domain checkpoint stateHash mismatch");
  if (checkpointSet.fileCount !== index.fileCount) throw new Error("domain checkpoint fileCount mismatch");
  validateWorkspacePointMutationReceipt(mutationReceipt, { expectedFrom: index.identity.stateHash });
  if (!nextState || !Array.isArray(nextState.files) || nextState.files.length !== index.fileCount) {
    throw new Error("next workspace state fileCount mismatch");
  }

  const nextFile = nextState.files[mutationReceipt.fileIndex];
  if (!nextFile || nextFile.id !== mutationReceipt.fileId) throw new Error("point mutation target file identity mismatch");
  const actualAfterEntries = workspaceFileDomainEntries(nextState, mutationReceipt.fileIndex);
  for (const domain of REALISTIC_DOMAINS) {
    const pair = mutationReceipt.domainEntries[domain];
    if (index.entriesByDomain[domain][mutationReceipt.fileIndex] !== pair.before) throw new Error(`stale point mutation base entry: ${domain}`);
    if (actualAfterEntries[domain] !== pair.after) throw new Error(`point mutation target entry mismatch: ${domain}`);
  }

  const entriesByDomain = { ...index.entriesByDomain };
  const domainHashes = Object.fromEntries(REALISTIC_DOMAINS.map((domain) => [domain, index.identity.domains[domain].hash]));
  const nextEntriesByDomain = {};
  for (const domain of mutationReceipt.changedDomains) {
    const nextEntries = [...index.entriesByDomain[domain]];
    nextEntries[mutationReceipt.fileIndex] = mutationReceipt.domainEntries[domain].after;
    entriesByDomain[domain] = nextEntries;
    nextEntriesByDomain[domain] = nextEntries;
  }

  const checkpointAdvance = checkpointSet.advanceChangedDomains({
    changedDomains: mutationReceipt.changedDomains,
    nextEntriesByDomain,
    fileIndex: mutationReceipt.fileIndex,
    toStateHash: mutationReceipt.toStateHash,
  });

  const fallbackMetrics = {};
  for (const domain of mutationReceipt.changedDomains) {
    if (checkpointAdvance.hashes[domain]) {
      domainHashes[domain] = checkpointAdvance.hashes[domain];
      continue;
    }
    const nextEntries = nextEntriesByDomain[domain];
    domainHashes[domain] = fullDomainHash(domain, index.fileCount, nextEntries);
    fallbackMetrics[domain] = Object.freeze({
      domain,
      mode: "full-domain-rehash-no-checkpoint",
      entriesRehashed: index.fileCount,
      entriesSkipped: 0,
      canonicalCharactersRehashed: fullDomainCanonicalCharacters(domain, index.fileCount, nextEntries),
      checkpointBytes: 0,
      exactCompatibility: true,
      suffixStillRehashed: false,
    });
  }

  const identity = createVersionedDomainIdentity({
    stateHash: mutationReceipt.toStateHash,
    domainHashes,
    previousIdentity: index.identity,
  });
  const checkpointMetrics = checkpointAdvance.metrics.metricsByDomain;
  const metricsByDomain = Object.freeze({ ...fallbackMetrics, ...checkpointMetrics });
  const changedDomains = [...mutationReceipt.changedDomains];
  const totalCanonicalCharactersRehashed = changedDomains.reduce(
    (sum, domain) => sum + metricsByDomain[domain].canonicalCharactersRehashed,
    0,
  );
  const totalEntriesRehashed = changedDomains.reduce((sum, domain) => sum + metricsByDomain[domain].entriesRehashed, 0);
  const totalEntriesSkipped = changedDomains.reduce((sum, domain) => sum + metricsByDomain[domain].entriesSkipped, 0);

  const nextIndex = {
    schema: index.schema,
    fileCount: index.fileCount,
    identity,
    entriesByDomain,
    lastAdvance: {
      mode: "point-incremental-domain-checkpointed",
      receiptHash: mutationReceipt.receiptHash,
      filesInspected: 1,
      domainsRehashed: changedDomains,
      checkpointedChangedDomains: checkpointAdvance.metrics.checkpointedChangedDomains,
      fallbackChangedDomains: checkpointAdvance.metrics.changedDomainsWithoutCheckpoint,
      domainCheckpointBytes: checkpointSet.checkpointBytes,
      totalDomainCanonicalCharactersRehashed: totalCanonicalCharactersRehashed,
      totalDomainEntriesRehashed: totalEntriesRehashed,
      totalDomainEntriesSkipped: totalEntriesSkipped,
      metricsByDomain,
    },
  };

  return Object.freeze({
    index: nextIndex,
    checkpointSet: checkpointAdvance.checkpointSet,
    metrics: Object.freeze(nextIndex.lastAdvance),
  });
}
