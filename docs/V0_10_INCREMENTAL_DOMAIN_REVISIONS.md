# AXM Ignition Fabric v0.10 — Incremental Canonical Domain Revisions

## Research question

Can the versioned domain/body identity model from v0.09 stop rescanning the full 2,500-file workspace after every supported point mutation, while preserving the exact same deterministic identity as the full-scan reference?

## Answer in this harness

Yes, for the explicit single-file point-mutation contract tested here.

v0.10 keeps the exact v0.09 domain hash format. It does not introduce a friendlier replacement identity scheme just to make incremental updates easier.

The runtime keeps the per-file canonical entry arrays used to construct each domain hash. A trusted point-mutation receipt carries the before/after canonical entry for **all seven domains of the changed file**.

On apply:

```text
trusted mutation receipt
        -> verify current cached before entries
        -> recompute actual after entries for one target file
        -> prove receipt changedDomains matches those entry changes
        -> update only changed domain entry arrays
        -> rehash only changed domains
        -> advance only changed revisions
        -> compare exact identity to full-scan reference
```

Unchanged domain entry arrays are retained rather than rescanned.

## Safety / fallback

Fast path requirements:

- same file count;
- same file identity at the target array position;
- valid receipt hash;
- `fromStateHash` matches current canonical identity;
- cached before entries match the receipt;
- actual target-file after entries match the receipt;
- `changedDomains` exactly equals domains whose before/after entries differ.

The point fast path is not used for structural changes such as reordering/replacing file identity.

Missing evidence uses full recomputation.

Stale, tampered, or wrong-target receipts are rejected.

## Correctness evidence

GitHub Actions run `33342230505` passed **56/56 tests** and every historical benchmark rung.

New v0.10 tests prove:

1. bootstrap identity equals the existing v0.09 full-scan identity;
2. path point update equals the exact full-scan reference identity;
3. import point update equals the exact full-scan reference identity;
4. unchanged domains are not copied/rehashed on the incremental path;
5. stale receipt is rejected;
6. tampered receipt is rejected;
7. receipt against the wrong actual target file is rejected;
8. missing evidence falls back to full recomputation;
9. structural reorder cannot masquerade as a point mutation and uses full fallback.

## Repeated benchmark

Fixture:

- 2,500 deterministic source files;
- six canonical transitions;
- five fresh Node processes per mode;
- 900,000-byte value-aware retention budget;
- direct deterministic result verification excluded from timing;
- whole-state fingerprint cost charged to **every** mode;
- each mode's identity bookkeeping charged to that mode.

Modes:

```text
full-state
    whole-state fingerprint
    + full cache invalidation on state change

full-domain
    whole-state fingerprint
    + rescan all seven canonical domains
    + granular body reuse

incremental
    whole-state fingerprint
    + one initial domain bootstrap
    + point mutation receipt
    + rehash changed domains only
    + granular body reuse
```

### Path-only changes

Six path changes affect `metadata` only.

| measure | full-state | full-domain | incremental |
| --- | ---: | ---: | ---: |
| runtime median | 416.88 ms | 88.11 ms | **87.79 ms** |
| charged end-to-end median | 536.75 ms | 607.32 ms | **273.33 ms** |
| identity-specific extra | 0 ms | 403.08 ms | **68.33 ms** |
| materialized bytes median | 6,056,540 B | 1,030,220 B | **1,030,220 B** |
| cache hits median | 0 | 6 | **6** |

Incremental identity costs inside that 68.33 ms median:

- initial 2,500-file bootstrap: **55.83 ms**;
- all six mutation-receipt builds combined: **1.06 ms**;
- all six incremental updates combined: **10.99 ms**.

Across the transitions themselves:

- files inspected: **6 total**;
- domains rehashed: **6 total**.

Observed median delta:

- incremental vs full-state end-to-end: **263.42 ms lower**;
- incremental vs full-domain end-to-end: **333.99 ms lower**;
- materialization avoided vs full-state: **5,026,320 B**.

### Import-target changes

Six same-width import-target changes affect `imports` + `content-hash`.

| measure | full-state | full-domain | incremental |
| --- | ---: | ---: | ---: |
| runtime median | 411.79 ms | 74.59 ms | **75.19 ms** |
| charged end-to-end median | 531.14 ms | 602.59 ms | **265.72 ms** |
| identity-specific extra | 0 ms | 412.41 ms | **67.46 ms** |
| materialized bytes median | 6,142,136 B | 1,115,816 B | **1,115,816 B** |
| cache hits median | 0 | 6 | **6** |

Incremental identity costs inside that 67.46 ms median:

- initial bootstrap: **55.91 ms**;
- all six mutation-receipt builds combined: **1.13 ms**;
- all six incremental updates combined: **10.31 ms**.

Across the transitions themselves:

- files inspected: **6 total**;
- domains rehashed: **12 total**.

Observed median delta:

- incremental vs full-state end-to-end: **265.41 ms lower**;
- incremental vs full-domain end-to-end: **336.87 ms lower**;
- materialization avoided vs full-state: **5,026,320 B**.

## What changed from v0.09

v0.09 proved that granular body validity substantially reduces runtime/materialization, but its full-domain rescan was expensive enough to erase that runtime advantage when identity construction was charged.

v0.10 removes that repeated rescan for supported point mutations.

The full-domain baseline still demonstrates the v0.09 failure shape:

```text
better cache reuse
+ expensive rediscovery of identity
= worse charged end-to-end result
```

The incremental path instead does:

```text
better cache reuse
+ small evidence-bound identity update
= lower charged end-to-end result in these traces
```

## Strongest supported claim

> In this deterministic 2,500-file harness, a cached canonical domain-entry index plus trusted point-mutation receipts can advance only affected domain revisions while producing the exact same domain identity as a full rescan. For the tested path/import traces, this preserves the v0.09 granular cache benefit while reducing identity bookkeeping enough to beat both whole-state invalidation and repeated full-domain rescanning on the charged five-sample medians.

## Boundaries

This does **not** prove:

- arbitrary structural mutations can use the point fast path;
- arbitrary semantic dependencies can be inferred automatically;
- mutation receipts are universally cheap to produce;
- canonical whole-state fingerprinting is solved or free;
- universal runtime speedup;
- production-scale superiority;
- global cache/eviction optimality;
- created RAM, free compute, or free energy.

Canonical `fromStateHash` / `toStateHash` remain upstream truth inputs. Their construction cost is still charged in the benchmark.

Five hosted samples reduce single-run noise but are not a broad statistical distribution.

## Next evidence gate

The budgeted runtime is still deliberately restricted to exactly one dependency-free matched capability per request.

Next rung:

**dependency-aware multi-capability worksets under the same truth/version/budget rules.**

Required proof should include:

- deterministic dependency closure;
- deterministic topological execution order;
- per-body domain validity inside one multi-capability request;
- partial cache hits inside a dependency closure;
- truth invalidation before value eviction;
- hard byte budget during multi-body admission;
- exact equality against the existing direct multi-capability reference;
- a broad/no-benefit counterexample where eager or cold execution is still allowed to win.
