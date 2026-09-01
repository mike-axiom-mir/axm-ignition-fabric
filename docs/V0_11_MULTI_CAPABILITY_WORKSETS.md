# AXM Ignition Fabric v0.11 — Dependency-Aware Multi-Capability Worksets

## Research question

Can the truth/version/budget architecture proven in v0.01-v0.10 execute a request that requires a deterministic graph of multiple capabilities, while preserving partial cache hits, per-body validity, hard retained-memory bounds and exact output equivalence?

## New runtime

`BudgetedWorksetSession`

The runtime accepts the same realistic capability registry but no longer restricts a request to one dependency-free capability.

For each request it now performs:

```text
request
-> matched capabilities
-> deterministic dependency closure
-> deterministic topological order
-> reconcile cached bodies against canonical domain identity
-> reuse valid bodies
-> materialize missing/stale bodies
-> execute closure with dependency outputs
-> deterministic retention / eviction
-> release non-retained bodies
-> exact result receipt
```

For the realistic report request, the deterministic order is:

```text
workspace-dependency-index
workspace-duplicate-index
workspace-lint-index
workspace-metadata-index
workspace-search-index
workspace-symbol-index
workspace-report-projection
```

The report projection receives outputs from all six prerequisite bodies.

## Memory boundary

The byte ceiling in v0.11 is explicitly a **retained-cache budget**.

It is not a claim that the runtime can always keep all instantaneous process allocation below that number.

A required closure can be larger than the retained budget. In that case required bodies may be materialized transiently for the current run and then released.

This is deliberate because correctness comes before retention policy:

```text
required for current truth/work? -> may execute
worth retaining afterward?       -> budget decision
```

The runtime never treats “does not fit retained cache” as permission to omit required work.

## Correctness gate

GitHub Actions run `33343906055` on head `69d29008cdd651ffc90cffa1c597a0e0acdadaf3` passed:

- **63/63 tests**
- all prior v0.01-v0.10 regression gates
- the new repeated dependency-aware workset benchmark

New tests prove:

- deterministic seven-body report closure
- deterministic topological order
- exact direct-baseline result equality
- partial warm hits inside one closure
- per-body domain validity after incremental truth change
- stale dependency body invalidation while unaffected search body survives
- a 962,268-byte required closure can execute under a 900,000-byte retained-cache ceiling
- zero-retention broad work keeps zero cache bytes and materializes exactly the direct required bytes
- missing dependency rejection
- dependency-cycle rejection

## Repeated benchmark

2,500 deterministic source files. Five fresh Node processes per mode.

Every report result is checked against the deterministic direct baseline before the sample is accepted.

### 1. Partial warm report

Two bodies already exist because they were used earlier:

- dependency index
- search index

A subsequent seven-body report therefore has 2 hits and 5 misses.

| measure | direct | workset |
|---|---:|---:|
| report wall median | 91.04 ms | **13.91 ms** |
| report materialized | 962,268 B | **84,820 B** |
| report cache hits | 0 | **2** |
| charged lifecycle | **113.66 ms** | 185.29 ms |

The report itself is much cheaper because 877,448 B of required bodies are already valid and warm.

But the benchmark also deliberately charges the workset for identity bootstrap and the two priming operations. If those priming operations were created solely to accelerate this one report, the workset loses by about 71.63 ms.

That is an important boundary:

> **Do not manufacture warm state just to claim a cache win. Reuse should come from work that was already useful or from repeated demand that amortizes its cost.**

### 2. Incremental truth change inside a warm closure

The dependency index and search index begin warm.

Then one import target changes. v0.10 incremental truth advances only:

- `imports`
- `content-hash`

The report run proves:

- dependency body becomes stale and is not a hit
- search body remains valid because `tokens` did not change
- one file is inspected by the incremental identity step
- two domains are rehashed

| measure | direct | workset |
|---|---:|---:|
| report wall median | 92.36 ms | **16.20 ms** |
| report materialized | 962,268 B | **124,548 B** |
| report cache hits | 0 | **1** |
| charged lifecycle | **133.33 ms** | 219.48 ms |

Again, report-only reuse is large, but the full lifecycle includes prior useful work + bootstrap. This is not promoted as a one-shot replacement speedup.

The important proof is the truth behavior:

```text
imports changed
-> dependency body invalid

tokens unchanged
-> search body remains valid
```

### 3. Repeated broad report under a 900 KB retained budget

The complete report closure is **962,268 B**, larger than the retained ceiling of **900,000 B**.

Three reports are executed.

| measure | direct | workset |
|---|---:|---:|
| three-report wall median | 250.52 ms | **115.21 ms** |
| charged lifecycle | 272.42 ms | **207.69 ms** |
| materialized bytes | 2,886,804 B | **1,121,724 B** |
| workset hits | 0 | **6** |
| final retained cache | 0 B | **882,540 B** |

Observed workset behavior:

- 12 budget evictions across the three-report trace
- 4 newly materialized bodies end non-retained/transient across the trace
- final retained set:
  - `workspace-report-projection`
  - `workspace-search-index`
  - `workspace-symbol-index`
- final cache remains below the 900 KB hard retained ceiling

This trace beats direct even after charging identity bootstrap:

- observed charged median reduction: **64.73 ms**
- avoided materialization: **1,765,080 B**

This is the first v0.11 trace where repeated multi-capability demand amortizes the extra machinery enough to win the charged lifecycle.

### 4. Zero-retention broad counterexample

Budget: **0 B**.

One broad report.

Both direct and workset must materialize the complete required body:

**962,268 B**

| measure | direct | workset |
|---|---:|---:|
| report wall median | **90.03 ms** | 97.40 ms |
| charged lifecycle | **112.22 ms** | 119.45 ms |
| materialized bytes | 962,268 B | 962,268 B |
| cache hits | 0 | 0 |
| final retained cache | 0 B | 0 B |

The simpler direct route wins by about **7.36 ms** on the hosted report median.

This counterexample is retained deliberately.

There is no dormant-body or reuse advantage to exploit here, so the generic workset machinery is just overhead.

## Supported claim

> In this deterministic workspace harness, a budgeted runtime can execute multi-capability dependency closures in deterministic topological order, reuse a valid subset of bodies, materialize only missing or stale bodies, preserve exact direct-baseline outputs, and enforce a hard retained-cache ceiling even when the required transient closure is larger than that ceiling.

The second half of the claim is equally important:

> The mechanism is conditional. Deliberate one-shot prewarming can lose, and zero-retention broad work can favor the simpler direct route.

## What v0.11 does not prove

- universal runtime speedup
- a hard limit on every transient process allocation
- automatic semantic dependency inference
- globally optimal eviction or retention
- production-scale superiority
- that every broad request benefits from a workset runtime
- created RAM
- free CPU cycles
- free energy
- a broad statistical timing distribution

## Evidence discipline

Keep all four traces.

Do not report only the tight-budget win.

The partial and mutation traces show that useful warm state can dramatically reduce later work, but creating warm state solely to win a one-shot benchmark is not free.

The zero-retention trace proves that when there is nothing useful to keep dormant/warm, direct execution remains a valid better choice.

## Next evidence gate

The next useful seam is **workset planning without eager closure materialization**.

v0.11 currently gathers all missing closure bodies before execution, then executes them in topological order and applies retention afterward. That is correct, but it can temporarily materialize the whole required closure.

A stronger v0.12 experiment would test **streamed/lifetime-aware workset execution**:

```text
plan closure
-> materialize next ready body
-> execute when dependencies available
-> release runtime body as soon as its future consumers no longer need it
-> retain only bodies justified by cache policy
```

Required proof should compare peak live body bytes, exact outputs, dependency liveness, retention behavior and orchestration overhead against the current v0.11 whole-closure materialization baseline.

Do not claim a physical-memory win until actual live allocation is measured.
