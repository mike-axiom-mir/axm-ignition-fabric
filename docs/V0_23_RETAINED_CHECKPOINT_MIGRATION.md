# Ignition v0.23 — Retained Checkpoint Migration

## Question

Can Ignition keep the exact v0.22 adaptive checkpoint decisions, replay behavior, and 20,000-byte retained-truth ceiling while removing reconstruction of checkpoint records that survive a selection change?

The v0.22 answer to **which truth should remain resident** was already deterministic and useful. Its measured weakness was migration: changing the selected set rebuilt checkpoint arrays that had already been selected to survive.

v0.23 changes only that migration path.

This is a software experiment on a deterministic 2,500-file workspace. It is not chip, PIM, datacenter, fleet, energy, or hardware evidence.

## Plain-language model

A domain checkpoint is an exact save point for one lane of canonical workspace truth.

v0.22 chose the right save points, but when moving from:

```text
[content-hash, imports]
        ↓
[imports, metadata]
```

it copied `imports` again even though `imports` was already exact and was meant to stay.

v0.23 carries the existing `imports` checkpoint forward unchanged, drops `content-hash`, and builds only the newly admitted `metadata` checkpoint.

The rule is:

> **Do not rebuild truth you decided to keep.**

## Preserved v0.22 contracts

v0.23 does not change:

- adaptive ranking;
- the four-mutation value window;
- position-weighted opportunity measurement;
- the one-full-domain admission penalty;
- deterministic tie-breaking;
- exact state-fingerprint advancement;
- exact per-domain hashes and revisions;
- domain suffix replay behavior;
- the persistent/current-set checkpoint budget;
- the phase-shift selection timeline.

No AI model makes the selection or migration decision.

## Migration semantics

Selection migration now partitions the next selected set into three explicit classes:

```text
retained domain
    reuse the existing checkpoint record and exact Uint32Array

newly admitted domain
    build one checkpoint record from current exact domain truth

evicted domain
    omit the old record from the next checkpoint set
```

The migration validates that:

- the source checkpoint set and current domain index have the same exact state hash;
- file counts match;
- retained checkpoint hashes still match current domain truth;
- newly built checkpoint hashes match current domain truth;
- retained checkpoint arrays are the same object identity before and after migration;
- the resulting current checkpoint set remains under the Governor's hard retained-byte ceiling.

Tests fail if a retained checkpoint array is reconstructed.

## Locked phase-shift transition

The v0.22 selection decisions remain exactly:

```text
step 2: [content-hash, imports]
step 6: [imports, metadata]
step 8: [metadata]
```

v0.23 migrates those decisions as follows:

```text
[]
→ [content-hash, imports]
    build content-hash 10 KB
    build imports      10 KB
    cumulative build   20 KB

→ [imports, metadata]
    reuse imports      10 KB
    evict content-hash 10 KB
    build metadata     10 KB
    cumulative build   30 KB

→ [metadata]
    reuse metadata     10 KB
    evict imports      10 KB
    build nothing       0 KB
    cumulative build   30 KB
```

## Deterministic measured result

The 2,500-file phase-shift workload still performs four late import mutations followed by five late metadata mutations.

| invariant / cost | v0.22 rebuild migration | v0.23 retained migration | change |
|---|---:|---:|---:|
| final state hash | `620413c8` | `620413c8` | unchanged |
| final canonical characters | 1,284,921 | 1,284,921 | unchanged |
| final selected domains | `[metadata]` | `[metadata]` | unchanged |
| maximum persistent checkpoint bytes | 20,000 | 20,000 | unchanged |
| domain replay characters | 496,836 | 496,836 | unchanged |
| domain entries rehashed | 15,007 | 15,007 | unchanged |
| domain entries skipped | 17,493 | 17,493 | unchanged |
| state-fingerprint replay characters | 5,334 | 5,334 | unchanged |
| reconfigurations | 3 | 3 | unchanged |
| checkpoint bytes evicted | 20,000 | 20,000 | unchanged |
| checkpoint bytes built | 50,000 | **30,000** | **20,000 fewer / 40%** |
| checkpoint build characters | 446,008 | **248,158** | **197,850 fewer / 44.36%** |
| charged domain canonical work | 942,844 | **744,994** | **197,850 fewer** |
| checkpoint bytes reused across migrations | unmeasured / rebuilt | **20,000** | newly explicit |

Each relevant domain checkpoint is now constructed exactly once:

- `content-hash`: one build;
- `imports`: one build;
- `metadata`: one build.

The surviving `imports` and `metadata` records each contribute 10,000 reused bytes across their respective migration.

## Exact replay gate

A no-domain-checkpoint reference and the adaptive v0.23 path execute the same mutation sequence.

The gate verifies equality of:

- final whole-state hash;
- exact canonical size;
- every domain hash;
- every domain revision;
- validated checkpoint hashes against current exact domain entries.

The phase-shift benchmark additionally locks domain replay at exactly 496,836 canonical characters. A migration optimization cannot pass by changing replay semantics or by selecting different checkpoints.

## Selection-decision gate

The benchmark reduces the decision history to step number plus selected domains and requires exact equality with the v0.22 timeline.

This matters because a lower construction result would be misleading if the Governor merely avoided a useful checkpoint or delayed admission.

v0.23 therefore proves a narrower statement:

```text
same decisions
same exact truth
same replay
same retained ceiling
less reconstruction
```

## Residency boundary

The hard 20,000-byte invariant applies to the exact checkpoint records retained by the current checkpoint set.

v0.23 does **not** claim that a JavaScript allocator never temporarily has old and newly admitted arrays live during the migration call. Physical transient allocator peak, garbage-collection timing, and backing-store release are not measured by this gate.

The supported claim is precise:

- the resulting/current selected checkpoint set never retains more than 20,000 bytes;
- retained domains reuse existing arrays rather than allocating replacements;
- only newly admitted domains allocate checkpoint arrays;
- evicted records are absent from the next set and become eligible for release when no other references remain.

A later allocator-lifetime gate would be needed to prove a physical transient-memory peak.

## Timing boundary

Five fresh Node processes per policy and scenario are measured by the comparison harness.

Hosted wall-clock medians remain observational. They can vary between CI runs and are not used as the v0.23 pass condition. The deterministic construction, replay, identity, selection, and retained-byte measurements are the evidence gate.

Cross-run timing against the sealed v0.22 run is therefore not promoted as a speedup claim.

## Strongest supported claim

> In the deterministic 2,500-file Ignition workspace harness, v0.23 preserved the exact v0.22 adaptive checkpoint choices, legacy-compatible state/domain truth, domain replay work, and 20,000-byte current-set residency ceiling while migrating checkpoint selections by reusing the exact records and Uint32Array storage of surviving domains. In the locked phase-shift workload, cumulative checkpoint construction fell from 50,000 to 30,000 bytes and checkpoint build work fell from 446,008 to 248,158 canonical characters. The 197,850-character reduction came entirely from removing retained-domain reconstruction; every relevant checkpoint was built once, 20,000 bytes were reused across migrations, and final truth and replay remained unchanged.

## What v0.23 does not prove

It does not prove:

- that adaptive retention is universally faster than static or no-checkpoint policies;
- that the v0.22 ranking/admission policy is globally optimal;
- that physical transient allocator usage never exceeds 20,000 bytes;
- immediate backing-store release after eviction;
- production-scale performance;
- a hardware, PIM, datacenter, energy, or fleet advantage.

The lucky static frequency policy and future-aware oracle remain valid comparison counterexamples.

## Next measured boundary

The next useful gate should not invent another scoring rule without evidence.

Two grounded candidates remain:

1. instrument physical transient allocation and release during checkpoint migration;
2. stress long alternating workload phases to measure churn, migration frequency, and whether deterministic hysteresis is justified.

Neither candidate is promoted until measured.

## Run

```bash
npm test
npm run benchmark:adaptive-truth-checkpoints
```

Evidence receipt:

- `evidence/ignition-v0.23-retained-checkpoint-migration.json`
