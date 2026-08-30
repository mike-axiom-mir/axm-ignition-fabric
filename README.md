# AXM Ignition Fabric

Experimental AXM research branch for testing whether a software body can keep large capability/state possibility dormant, materialize only the workset required by the current event, execute within explicit resource bounds, merge the result deterministically back into persistent truth, and release or retain work according to grounded reuse/resource conditions.

## v0.06 research question

When canonical truth changes, can the runtime invalidate only derived bodies whose declared source domains changed instead of throwing away the complete warm body?

The scoped path must preserve exact results and must fall back to full invalidation whenever the transition evidence is missing, stale, or not safely mapped.

## Core loop

```text
canonical truth + capability registry
        -> request / event
        -> one canonical state fingerprint
        -> choose direct / cold / warm / eager execution
        -> materialize or reuse bounded workset
        -> deterministic result
        -> canonical transition receipt
        -> resolve affected source domains
        -> invalidate only dependent cached bodies
        -> retain unaffected verified bodies
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

A warm session can now accept a hash-bound transition receipt:

```text
fromStateHash
+ toStateHash
+ changedDomains
+ evidence
+ receiptHash
```

The receipt is resolved against explicit capability/source-domain bindings.

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

GitHub Actions run `33332487877` passed **33/33 tests** plus the complete v0.01-v0.05 benchmark stack and the new scoped invalidation benchmark.

#### Path-only mutation

Five deterministic path changes affected only the `metadata` source domain.

| Strategy | Rebuilt bytes | Measured transition + first-report wall time |
| --- | ---: | ---: |
| full invalidation | 4,811,340 B | 345.60 ms |
| scoped invalidation | 137,500 B | 13.17 ms |
| avoided rebuild | **4,673,840 B** | observed delta 332.43 ms |

Each scoped transition released and rebuilt only the 27,500-byte metadata body while retaining the other six bodies.

#### Import-target mutation

Four same-width import-target changes affected `imports` and `content-hash` only.

| Strategy | Rebuilt bytes | Measured transition + first-report wall time |
| --- | ---: | ---: |
| full invalidation | 3,849,072 B | 277.79 ms |
| scoped invalidation | 198,912 B | 18.97 ms |
| avoided rebuild | **3,650,160 B** | observed delta 258.82 ms |

Each scoped transition released and rebuilt only the dependency index plus duplicate-content index, 49,728 bytes total per transition.

Every resulting report hash matched a fresh direct baseline.

Timing boundary: transition-receipt generation is upstream and excluded from these invalidation measurements. The measured interval includes cache release/invalidation plus the first report run against the new canonical state.

Evidence:

- `evidence/ignition-v0.06-scoped-invalidation.json`

## Current supported claim

> In these deterministic harnesses, dormant materialization can reduce real derived runtime allocation, warm reuse can avoid repeated reconstruction, an adaptive Governor can choose or refuse retention, and a trusted hash-bound change receipt can preserve unaffected warm bodies across canonical state changes while rebuilding only declared dependent bodies.

The architecture remains conditional:

> **Use Ignition where dormant possibility or reusable derived state pays for the orchestration. Use direct/eager execution where it does not. When truth changes, reuse only what the evidence proves remains valid.**

## This does NOT prove

- software creates RAM, CPU cycles, energy, or free compute;
- universal runtime speedup;
- global Governor optimality;
- production-scale superiority;
- statistically established timing distributions from single hosted samples;
- automatic discovery of arbitrary dependency semantics;
- that upstream change receipts are free to compute;
- optimal cache eviction;
- that every AXM capability should use this runtime pattern.

Scoped invalidation correctness depends on complete, truthful upstream transition evidence. The current domain bindings are explicit harness declarations, not universal semantic inference.

## Run

```bash
npm test
npm run demo
npm run benchmark:memory
npm run benchmark:realistic
npm run benchmark:warm
npm run benchmark:governor
npm run benchmark:invalidation
```

Evidence receipts:

- `evidence/ignition-v0.02-ci-memory.json`
- `evidence/ignition-v0.03-realistic-workload.json`
- `evidence/ignition-v0.04-warm-break-even.json`
- `evidence/ignition-v0.05-governor-pre-fingerprint.json`
- `evidence/ignition-v0.05-governor.json`
- `evidence/ignition-v0.06-scoped-invalidation.json`

## Next evidence gate

Scoped invalidation can preserve useful cached bodies, but a real runtime also needs to decide what deserves scarce memory.

Next rung:

**value-aware deterministic eviction under a hard memory budget**

Candidate evidence-bound inputs:

- body bytes
- measured reconstruction/materialization cost
- recent reuse count
- recency
- dependency/route relevance
- cache budget

The first policy must be simple, deterministic and inspectable. Compare it against at least:

- no retention;
- retain-everything-until-budget-fails;
- simple LRU/recency policy;
- value-aware policy.

The value-aware policy must be allowed to lose. If LRU or no retention is cheaper for a workload, record that result rather than tuning the benchmark around the new policy.

## Lane rule

See `AGENTS.md`.

> **1 AI CHAT = 1 LANE. NO SPREAD.**

Current lane: issue #2 / `axm/ignition-v0.01-materialization-core`.

## Evidence discipline

Do not promote proposals into verified capability. Keep baselines, counterexamples, failed runs, repairs, receipts, and benchmark evidence together so every improvement is compared against simpler execution.
