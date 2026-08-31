# v0.19 — Mutation-maintained canonical size hints

## Research question

Can exact canonical-size route knowledge be maintained from trusted point mutations so fingerprint routing avoids v0.17's repeated structural preflight without weakening canonical truth?

v0.17 solved the monolithic-versus-streaming choice, but every tracked large-state fingerprint still performs a capped structural walk just to rediscover that the state is large.

v0.19 asks whether the mutation path can maintain that route knowledge at mutation time instead.

## Mechanism

The tracked workspace now carries a state-bound canonical-size hint receipt.

```text
trusted canonical workspace
-> exact canonical-size hint

point mutation
-> inspect old file canonical representation
-> inspect new file canonical representation
-> update total canonical character count by delta
-> bind new size hint to new state hash
-> choose fingerprint route from exact size
-> zero adaptive preflight nodes
```

The exact canonical character count is calculated scalarly. The bootstrap does not need to materialize `stableStringify(state)` merely to count it.

For ordinary arbitrary/untracked values, nothing changes: live `hashValue(value)` remains the sealed v0.17 adaptive policy.

## Truth contract

The size hint is not caller folklore.

Tests require:

- exact scalar canonical length equals `stableStringify(value).length` across representative supported values, including escaping, Unicode and lone surrogates;
- workspace hints exactly equal full canonical serialization length at 25, 100, 250 and 2,500 files;
- every tracked point mutation ends with an independently verified exact canonical size;
- hinted fingerprint hash equals the canonical hash;
- stale or tampered hints reject;
- same-width mutations may change truth while canonical size remains unchanged;
- the same point-mutation receipt still feeds the existing v0.10 incremental domain identity.

This is one truth pipeline, not a parallel size-only universe.

## Failure lineage

Two failures were preserved before the measurement run.

### Fixture failure

Run `33379434647` failed because the same-width import test selected file 0. File 0 is intentionally the deterministic duplicate fixture and contains no imports.

Repair: use file 1 and toggle equal-width `file-2.js` / `file-3.js` targets. No algorithm change.

### Benchmark contract failure

Run `33379628571` reached v0.19 after all 22 historical gates passed, then the new benchmark incorrectly compared:

- an 8-mutation timing final state
- against a 1-mutation memory final state

and called the deliberately different hashes "unstable".

Repair: compare timing-vs-timing and memory-vs-memory only at equal mutation depth. No algorithm change.

## Measurement run

Head: `096dbe0c017f842e672187458f51595f8b2fad1b`

GitHub Actions run `33379985953`:

- **106/106 tests PASS**
- all **23 CI/evidence gates PASS**

Five fresh timing processes and five fresh `--expose-gc` memory processes were used per method/scenario.

## Result 1 — growing paths, 2,500 files

Eight mutations.

Both methods end with:

- hash `d1aa0108`
- canonical characters `1,284,880`
- route `streaming`

| measure | v0.17 adaptive | v0.19 hinted |
|---|---:|---:|
| route preflight nodes | 6,424 | **0** |
| size-hint file inspections | 0 | **8** |
| timing median | **85.598 ms** | 87.111 ms |
| one-mutation heapUsed peak | **19,440 B** | 30,736 B |
| one-mutation heapTotal peak | **0 B** | 262,144 B |
| one-mutation RSS peak | 1,810,432 B | **262,144 B** |

Structural route work collapses from 6,424 node visits to eight changed-file inspections.

But timing is about **1.513 ms slower**, and heap high-water is modestly worse. RSS is about **1.548 MB lower** in the hosted median.

This is not a universal performance win.

## Result 2 — same-width import mutations, 2,500 files

Eight alternating equal-width import mutations.

The important truth property is:

```text
canonical characters: 1,284,856 -> 1,284,856
state truth: changes
```

So representation size does not masquerade as identity.

Both timing paths end with hash `7e77d21a` after the even number of toggles, while the one-mutation memory path has hash `ef659207` and the same canonical size.

| measure | v0.17 adaptive | v0.19 hinted |
|---|---:|---:|
| route preflight nodes | 6,424 | **0** |
| size-hint file inspections | 0 | **8** |
| timing median | 90.194 ms | **85.683 ms** |
| one-mutation heapUsed peak | **19,648 B** | 30,160 B |
| one-mutation heapTotal peak | **0 B** | 262,144 B |
| one-mutation RSS peak | 1,814,528 B | **176,128 B** |

Here the hinted path is about **4.511 ms faster** and uses about **1.638 MB less RSS**, while heapUsed/heapTotal still move in the worse direction.

## Result 3 — threshold crossing

A 100-file workspace begins below the 65,536-character route threshold. One tracked mutation grows one file enough to cross it.

Final:

- hash `9f90a0c3`
- canonical characters `68,989`
- route `streaming`

| measure | v0.17 adaptive | v0.19 hinted |
|---|---:|---:|
| route preflight nodes | 586 | **0** |
| size-hint file inspections | 0 | **1** |
| timing median | **2.872 ms** | 3.251 ms |
| heapUsed peak | **65,480 B** | 72,360 B |
| RSS peak | 1,048,576 B | **524,288 B** |

The route flips correctly from maintained exact size with no selection scan. The hinted path is about **0.380 ms slower** in this hosted sample.

## What v0.19 proves

The structural claim survives:

> For the tracked point-mutation contract in this deterministic workspace harness, exact canonical representation size can be maintained from one changed file and used to select the same fingerprint route with zero adaptive preflight nodes.

Across eight 2,500-file mutations, 6,424 route-selection node visits become eight one-file size inspections while exact hashes and canonical sizes remain unchanged.

## What v0.19 does not prove

It does not prove:

- fingerprinting itself is O(1); the selected full hash still processes canonical truth;
- maintained hints are universally faster;
- maintained hints universally reduce heap or RSS;
- arbitrary untracked objects may safely supply size metadata;
- every mutation type can use the point-delta contract;
- structural/reorder mutations avoid fallback;
- production, fleet, datacenter, energy or cloud-cost savings.

Timing is explicitly mixed. Heap high-water is slightly worse in all three measured memory scenarios, while RSS is lower in all three hosted medians.

## Strongest supported claim

> In this deterministic tracked-workspace harness, exact canonical representation size can be maintained from one changed file per trusted point mutation and used to choose the same fingerprint route with zero adaptive preflight nodes. Across eight 2,500-file mutations this replaced 6,424 preflight node visits with eight one-file size inspections while preserving exact hashes and canonical lengths. Timing was mixed and heapUsed peak was modestly worse, so v0.19 supports incremental route knowledge, not a universal speed or memory win.

## Evidence

- `evidence/ignition-v0.19-canonical-size-hint.json`
- this report
- prior v0.02-v0.18 evidence remains intact

## Next gate

### v0.20 — one mutation, one truth advance

v0.19 still has a deeper redundancy:

```text
trusted point mutation
-> maintain canonical size
-> compute full new state fingerprint
-> separately update domain identity
```

The next research question is:

**Can one trusted mutation event incrementally advance canonical size, canonical state fingerprint and domain identity together, so the system does not repeatedly rediscover consequences already contained in the mutation evidence?**

The hash must remain exactly compatible with the current canonical state hash, with full recomputation retained as the oracle/fallback.

> **Do not recompute a consequence that the trusted change already determines.**
