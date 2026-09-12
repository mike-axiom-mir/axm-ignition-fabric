const EXPECTED_SCHEMA = 'axm.ignition-evidence/v0.23';

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`);
  }
  return value;
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new TypeError(`${label} must be an array of non-empty strings`);
  }
  return [...value];
}

export function validateIgnitionEvidence(receipt) {
  requireObject(receipt, 'evidence');
  if (receipt.schema !== EXPECTED_SCHEMA) {
    throw new TypeError(`unsupported evidence schema: ${String(receipt.schema ?? 'missing')}`);
  }

  const phase = requireObject(receipt.phaseShift, 'phaseShift');
  const delta = requireObject(receipt.deltaFromV022, 'deltaFromV022');
  const proof = requireObject(receipt.storageIdentityProof, 'storageIdentityProof');
  const truth = requireObject(receipt.truthBoundary, 'truthBoundary');
  const timeline = phase.selectionTimeline;
  const migrations = phase.migrationConstruction;

  if (!Array.isArray(timeline) || !Array.isArray(migrations) || timeline.length === 0 || timeline.length !== migrations.length) {
    throw new TypeError('selectionTimeline and migrationConstruction must be equal-length non-empty arrays');
  }

  timeline.forEach((entry, index) => {
    requireObject(entry, `selectionTimeline[${index}]`);
    requireFiniteNumber(entry.step, `selectionTimeline[${index}].step`);
    requireStringArray(entry.domains, `selectionTimeline[${index}].domains`);
  });

  migrations.forEach((entry, index) => {
    requireObject(entry, `migrationConstruction[${index}]`);
    if (typeof entry.transition !== 'string' || !entry.transition.trim()) {
      throw new TypeError(`migrationConstruction[${index}].transition must be a non-empty string`);
    }
    requireStringArray(entry.addedDomains, `migrationConstruction[${index}].addedDomains`);
    requireStringArray(entry.retainedDomains, `migrationConstruction[${index}].retainedDomains`);
    requireStringArray(entry.evictedDomains, `migrationConstruction[${index}].evictedDomains`);
    requireFiniteNumber(entry.bytesBuilt, `migrationConstruction[${index}].bytesBuilt`);
    requireFiniteNumber(entry.bytesRetainedFromPrior, `migrationConstruction[${index}].bytesRetainedFromPrior`);
    requireFiniteNumber(entry.bytesEvicted, `migrationConstruction[${index}].bytesEvicted`);
  });

  requireFiniteNumber(phase.maxPersistentCheckpointBytes, 'phaseShift.maxPersistentCheckpointBytes');
  requireFiniteNumber(phase.finalPersistentCheckpointBytes, 'phaseShift.finalPersistentCheckpointBytes');
  requireFiniteNumber(delta.priorCheckpointBytesBuilt, 'deltaFromV022.priorCheckpointBytesBuilt');
  requireFiniteNumber(delta.currentCheckpointBytesBuilt, 'deltaFromV022.currentCheckpointBytesBuilt');
  requireFiniteNumber(delta.checkpointBytesBuiltReductionPercent, 'deltaFromV022.checkpointBytesBuiltReductionPercent');
  requireFiniteNumber(delta.priorCheckpointBuildCanonicalCharacters, 'deltaFromV022.priorCheckpointBuildCanonicalCharacters');
  requireFiniteNumber(delta.currentCheckpointBuildCanonicalCharacters, 'deltaFromV022.currentCheckpointBuildCanonicalCharacters');
  requireFiniteNumber(delta.checkpointBuildCanonicalCharactersReductionPercent, 'deltaFromV022.checkpointBuildCanonicalCharactersReductionPercent');

  if (typeof phase.exactReplayPreserved !== 'boolean' || typeof phase.hardResidencyCeilingPreserved !== 'boolean') {
    throw new TypeError('phaseShift replay and residency preservation flags must be boolean');
  }
  if (typeof proof.retainedCheckpointRecordReused !== 'boolean' || typeof proof.pureEvictionBuildsZeroBytes !== 'boolean') {
    throw new TypeError('storageIdentityProof flags must be boolean');
  }
  if (typeof truth.strongestSafeClaim !== 'string' || !Array.isArray(truth.notClaimed)) {
    throw new TypeError('truthBoundary must contain strongestSafeClaim and notClaimed');
  }
  return receipt;
}

export function projectIgnitionEvidence(receipt) {
  validateIgnitionEvidence(receipt);
  const phase = receipt.phaseShift;
  const delta = receipt.deltaFromV022;
  const ceiling = phase.maxPersistentCheckpointBytes || 1;
  const steps = phase.selectionTimeline.map((selection, index) => {
    const migration = phase.migrationConstruction[index];
    const residentBytes = migration.bytesBuilt + migration.bytesRetainedFromPrior;
    return {
      index,
      step: selection.step,
      transition: migration.transition,
      selectedDomains: [...selection.domains],
      addedDomains: [...migration.addedDomains],
      retainedDomains: [...migration.retainedDomains],
      evictedDomains: [...migration.evictedDomains],
      bytesBuilt: migration.bytesBuilt,
      bytesRetained: migration.bytesRetainedFromPrior,
      bytesEvicted: migration.bytesEvicted,
      residentBytes,
      residentRatio: Math.min(1, residentBytes / ceiling),
      buildRatio: Math.min(1, migration.bytesBuilt / ceiling),
      retainedRatio: Math.min(1, migration.bytesRetainedFromPrior / ceiling),
    };
  });

  return Object.freeze({
    schema: receipt.schema,
    title: receipt.title,
    status: receipt.status,
    source: receipt.source ? { ...receipt.source } : null,
    headline: Object.freeze({
      bytesBefore: delta.priorCheckpointBytesBuilt,
      bytesAfter: delta.currentCheckpointBytesBuilt,
      bytesReductionPercent: delta.checkpointBytesBuiltReductionPercent,
      workBefore: delta.priorCheckpointBuildCanonicalCharacters,
      workAfter: delta.currentCheckpointBuildCanonicalCharacters,
      workReductionPercent: delta.checkpointBuildCanonicalCharactersReductionPercent,
      maxResidentBytes: phase.maxPersistentCheckpointBytes,
      finalResidentBytes: phase.finalPersistentCheckpointBytes,
      exactReplayPreserved: phase.exactReplayPreserved,
      ceilingPreserved: phase.hardResidencyCeilingPreserved,
    }),
    steps: Object.freeze(steps.map((step) => Object.freeze(step))),
    final: Object.freeze({
      hash: phase.finalHash,
      selectedDomains: Object.freeze([...(phase.finalSelectedDomains ?? [])]),
      domainReplayCanonicalCharacters: phase.domainReplayCanonicalCharacters,
      storageIdentity: Object.freeze({ ...receipt.storageIdentityProof }),
    }),
    truth: Object.freeze({
      strongestSafeClaim: receipt.truthBoundary.strongestSafeClaim,
      notClaimed: Object.freeze([...receipt.truthBoundary.notClaimed]),
    }),
  });
}

export function clampStep(index, stepCount) {
  if (!Number.isInteger(stepCount) || stepCount <= 0) return 0;
  return Math.max(0, Math.min(stepCount - 1, Number.isFinite(index) ? Math.trunc(index) : 0));
}
