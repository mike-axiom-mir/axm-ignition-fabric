# AXM Ignition Fabric

Experimental AXM research branch for testing whether a software body can keep large capability/state possibility dormant, materialize only the workset required by the current event, execute within explicit resource bounds, merge the result deterministically back into persistent truth, and release or retain work according to grounded reuse/resource conditions.

## v0.07 research question

When useful derived bodies compete for scarce memory, can a deterministic runtime enforce a hard cache ceiling and choose what to keep using measured reconstruction cost, observed reuse and body size without losing exact truth?

The value-aware policy must be compared against simpler policies and is explicitly allowed to lose.

## Core loop

```text
canonical truth + capability registry
        -> request / event
        -> one canonical state fingerprint
        -> choose direct / cold / warm / eager execution
        -> materialize or reuse bounded workset
        -> deterministic result
        -> optional canonical transition receipt
        -> scoped invalidation where evidence permits
        -> hard memory budget
        -> retain / evict / transient-use derived bodies
```

## Evidence ladder

### v0.01 - logical materialization

Deterministic relevance matching, dependency closure, eager-vs-Ignition result equivalence, receipts, and release lifecycle.

### v0.02 - physical allocation harness

Real `Uint8Array` capability bodies and isolated child-process memory probes showed that dormant irrelevant bodies can reduce actual runtime ArrayBuffer allocation.

Allocator boundary: dropping runtime references does **not** guarantee immediate OS/backing-store memory return. Post-release process memory is observational, not a pass/fail invariant.

### v0.03 - realistic parsed/indexed workload

A deterministic 2,500-file software workspace materializes real derived state:

- metadata index
- dependency index parsed from imports
- symbol index parsed from exports
- token-occurrence search index
- duplicate-content hash index
- lint-marker index
- report projection

Narrow requests save derived-state allocation. A broad report uses every body and preserves an explicit **0-byte saving** counterexample.

### v0.04 - warm reuse + corrected break-even timing

Four fixed modes are compared with equal outer wall-clock boundaries:

- **direct-cold** - fixed direct route, rebuild requested body
- **Ignition-cold** - generic relevance/dependency route, rebuild requested body
- **Ignition-warm** - generic route with state-bound cache
- **eager-warm** - retain the complete body

The first v0.04 timing harness had an unfair boundary because warm-session internal timing began after state hashing/planning. Those original cross-mode speed numbers are explicitly superseded in `evidence/ignition-v0.04-warm-break-even.json`. The allocation/cache evidence remains valid.

Corrected findings:

- warm reuse avoids repeated derived-body reconstruction;
- narrow repeated work can retain far less than eager;
- search is a weaker case because the requested search index dominates the body;
- broad work can fill the Ignition cache until it equals eager size;
- warm benefit must amortize routing/state-validation cost;
- direct or eager execution can be the grounded choice.

### v0.05 - adaptive Governor + shared truth fingerprint

The Governor chooses among:

```text
direct-cold
Ignition-cold
Ignition-warm
eager-warm
```

using route breadth, reuse, measured capability bytes, cache budget, retained cache contents and canonical state-change rate.

The first Governor benchmark exposed a large avoidable orchestration cost: the same 2,500-file canonical state was fingerprinted once by the Governor and again by the selected execution path.

That pre-repair baseline is preserved in:

- `evidence/ignition-v0.05-governor-pre-fingerprint.json`

The repaired Governor computes one canonical fingerprint and hands it into the selected executor. `tests/fingerprint-handoff.test.mjs` proves the execution receipt reuses that exact fingerprint.

Evidence:

- `evidence/ignition-v0.05-governor.json`

Supported behavior:

- repeated narrow work may promote to Ignition-warm;
- repeated broad work may promote to eager-warm;
- a hard cache budget may deliberately reject a faster unconstrained warm mode;
- high canonical state churn can return to cold execution;
- broad route growth can fill the cache to eager size;
- all governed outputs remain exactly equivalent to the deterministic direct baseline.

### v0.06 - deterministic dependency-scoped invalidation

A warm session can accept a hash-bound transition receipt:

```text
fromStateHash
+ toStateHash
+ changedDomains
+ evidence
+ receiptHash
```

The receipt resolves against explicit capability/source-domain bindings.

Current realistic-workload bindings:

| Capability body | Source domain |
| --- | --- |
| metadata index | metadata |
| dependency index | imports |
| symbol index | symbols |
| search index | tokens |
| duplicate index | content-hash |
| lint index | lint |
| report projection | risk |

Safety rules:

- unknown binding -> invalidate by default;
- wrong transition base -> reject receipt;
- canonical state changed without a trusted transition receipt -> full cache invalidation;
- scoped invalidation never changes canonical output expectations.

GitHub Actions run `33332487877` passed **33/33 tests** plus the complete earlier benchmark stack and the scoped invalidation benchmark.

#### Path-only mutation

Five deterministic path changes affected only `metadata`.

| Strategy | Rebuilt bytes | Transition + first-report wall time |
| --- | ---: | ---: |
| full invalidation | 4,811,340 B | 345.60 ms |
| scoped invalidation | 137,500 B | 13.17 ms |
| avoided rebuild | **4,673,840 B** | observed delta 332.43 ms |

#### Import-target mutation

Four same-width import-target changes affected `imports` and `content-hash`.

| Strategy | Rebuilt bytes | Transition + first-report wall time |
| --- | ---: | ---: |
| full invalidation | 3,849,072 B | 277.79 ms |
| scoped invalidation | 198,912 B | 18.97 ms |
| avoided rebuild | **3,650,160 B** | observed delta 258.82 ms |

Every resulting report hash matched a fresh direct baseline.

Timing boundary: transition-receipt generation is upstream and excluded from these invalidation measurements. The measured interval includes cache release/invalidation plus the first report run against the new canonical state.

Evidence:

- `evidence/ignition-v0.06-scoped-invalidation.json`

### v0.07 - hard-budget deterministic retention

v0.07 adds `BudgetedRetentionSession` for the first bounded eviction experiment.

Current v0.07 scope is deliberately narrow: exactly one dependency-free matched capability per request. This isolates retention policy from multi-capability merge complexity.

Hard rules:

- `cacheBytesAfter <= maxCacheBytes` on every run;
- a body larger than the complete budget is used transiently and released;
- no-retention, LRU and value-aware policies all produce the same direct-baseline result hashes;
- canonical state change currently invalidates the complete v0.07 budget cache;
- the cache policy never gains truth authority.

Policies:

**none**
- never retain derived bodies.

**LRU**
- evict the least-recently-used body when the byte ceiling would be exceeded.

**value**
- score retained bodies from measured materialization time × observed hit count, normalized by body size;
- evict the lowest deterministic score first.

The first LRU test initially failed because its fixture used a 40 KB limit that could actually hold both tested bodies, so no eviction correctly occurred. The fixture was repaired to 20 KB. No eviction algorithm change was required.

GitHub Actions run `33332834767` passed **38/38 tests** plus all earlier benchmarks and the new retention comparison.

#### Hot expensive search

Budget: 900,000 B. The search body is 837,720 B and was used three times before a burst of smaller indexes.

| Policy | Wall time | Materialized bytes | Hits | Evictions |
| --- | ---: | ---: | ---: | ---: |
| none | 648.45 ms | 6,793,808 B | 0 | 0 |
| LRU | 297.99 ms | 1,767,488 B | 6 | 2 |
| **value** | **229.58 ms** | **929,768 B** | **7** | **1** |

LRU evicted the old 837,720-byte search body after its first three hits. The value policy instead evicted the cheaper 39,728-byte dependency body, retained search, and avoided rebuilding the expensive search index later.

#### Low reuse

Four different bodies were requested exactly once.

| Policy | Wall time | Hits | Final retained bytes |
| --- | ---: | ---: | ---: |
| none | 72.39 ms | 0 | **0 B** |
| LRU | 76.01 ms | 0 | 92,048 B |
| value | 70.07 ms | 0 | 92,048 B |

The few-millisecond timing ordering is not treated as a retention win because nobody got a cache hit. Both retention policies consumed memory with zero observed reuse. No-retention is therefore the lower-memory grounded choice for this trace.

#### Alternating small bodies

Budget: 60,000 B. Dependency and symbol bodies alternate and cannot coexist under the ceiling.

| Policy | Wall time | Hits | Evictions |
| --- | ---: | ---: | ---: |
| none | 216.25 ms | 0 | 0 |
| **LRU** | **205.06 ms** | 0 | 11 |
| value | 206.24 ms | 0 | 11 |

Neither retention policy achieved a single hit. Both thrashed on every switch. LRU was slightly faster than value in this hosted sample, preserving an explicit counterexample where the value policy adds no useful cache behavior.

Timing boundary: each policy runs in a fresh Node process. Direct reference verification is completed before policy timing. Single hosted samples are observations, not statistical timing distributions.

Evidence:

- `evidence/ignition-v0.07-value-aware-retention.json`

## Current supported claim

> In these deterministic harnesses, dormant materialization can reduce real derived runtime allocation, warm reuse can avoid repeated reconstruction, an adaptive Governor can choose or refuse retention, trusted transition receipts can preserve unaffected bodies across state changes, and a hard-budget retention policy can deterministically choose which derived bodies remain warm while preserving exact outputs.

The architecture remains conditional:

> **Use Ignition only where dormancy, reuse, scoped validity, or selective retention actually pays for the orchestration. Direct, eager, LRU, or no retention remain valid outcomes when measurement supports them.**

## This does NOT prove

- software creates RAM, CPU cycles, energy, or free compute;
- universal runtime speedup;
- global Governor or eviction-policy optimality;
- production-scale superiority;
- statistically established timing distributions from single hosted samples;
- automatic discovery of arbitrary dependency semantics;
- that upstream change receipts are free to compute;
- that measured materialization time is a timeless intrinsic value signal;
- that every AXM capability should use this runtime pattern.

v0.07 budgeted retention is not yet integrated with v0.06 scoped invalidation. Its state change fallback currently invalidates the complete budget cache.

## Run

```bash
npm test
npm run demo
npm run benchmark:memory
npm run benchmark:realistic
npm run benchmark:warm
npm run benchmark:governor
npm run benchmark:invalidation
npm run benchmark:retention
```

Evidence receipts:

- `evidence/ignition-v0.02-ci-memory.json`
- `evidence/ignition-v0.03-realistic-workload.json`
- `evidence/ignition-v0.04-warm-break-even.json`
- `evidence/ignition-v0.05-governor-pre-fingerprint.json`
- `evidence/ignition-v0.05-governor.json`
- `evidence/ignition-v0.06-scoped-invalidation.json`
- `evidence/ignition-v0.07-value-aware-retention.json`

## Next evidence gate

The next useful rung is not a new scoring trick. It is integration:

**combine v0.06 scoped transition invalidation with v0.07 hard-budget retention.**

Target loop:

```text
canonical transition receipt
        -> invalidate only stale cached bodies
        -> keep unaffected verified bodies
        -> enforce hard byte ceiling
        -> evict low-value valid bodies only if budget requires it
        -> execute against one canonical state fingerprint
```

Compare this combined runtime against:

- full invalidation + no retention;
- scoped invalidation without a hard budget;
- hard-budget retention with full state invalidation;
- simple LRU;
- value-aware retention.

Repeated samples or aggregated runs should be added before using timing differences as stronger performance evidence.

## Lane rule

See `AGENTS.md`.

> **1 AI CHAT = 1 LANE. NO SPREAD.**

Current lane: issue #2 / `axm/ignition-v0.01-materialization-core`.

## Evidence discipline

Do not promote proposals into verified capability. Keep baselines, counterexamples, failed runs, repairs, receipts, and benchmark evidence together so every improvement is compared against simpler execution.
