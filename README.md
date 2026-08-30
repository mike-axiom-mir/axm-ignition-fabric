# AXM Ignition Fabric

Experimental AXM research branch for testing whether a software body can keep large capability/state possibility dormant, materialize only the workset required by the current event, execute within explicit resource bounds, merge the result deterministically back into persistent truth, and release or retain work according to grounded reuse/resource conditions.

## v0.05 research question

Can the runtime choose among direct, cold, warm, and eager execution instead of treating Ignition as a universal mode?

The adaptive Governor must preserve exact results, respect memory limits, react to state churn, and be allowed to choose **NOT IGNITION**.

## Core loop

```text
canonical truth + capability registry
        -> request / event
        -> one canonical state fingerprint
        -> relevance / breadth / reuse / budget check
        -> choose execution mode
        -> materialize or reuse bounded workset
        -> execute exact relevant closure
        -> deterministic result / receipt
        -> retain useful body OR stay cold
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

Four fixed modes:

- **direct-cold** - fixed direct route, rebuild requested body
- **Ignition-cold** - generic relevance/dependency route, rebuild requested body
- **Ignition-warm** - generic route with state-bound cache
- **eager-warm** - retain the complete body

Important correction:

The first v0.04 timing harness used an unfair boundary: warm-session internal timing began after state hashing/planning. Those early cross-mode speed numbers are superseded. Allocation/cache evidence remains valid.

Corrected equal-boundary run `33331984076` used an outside stopwatch around the complete run call:

| Scenario | Requests | Direct cold | Ignition cold | Ignition warm | Eager warm | Ignition cache | Eager cache |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| dependencies | 20 | 304.66 ms | 583.82 ms | **293.50 ms** | 373.52 ms | 39,728 B | 962,268 B |
| search | 8 | 650.69 ms | 727.18 ms | **212.55 ms** | 225.16 ms | 837,720 B | 962,268 B |
| report | 6 | 581.28 ms | 653.62 ms | **203.60 ms** | 210.12 ms | 962,268 B | 962,268 B |
| breadth | 12 | 492.58 ms | 664.57 ms | 294.32 ms | **290.57 ms** | 962,268 B | 962,268 B |

Single hosted-run timings are observations, not statistical performance distributions.

Findings:

1. Warm reuse eliminates repeated derived-body reconstruction.
2. On narrow repeated work, warm Ignition retains much less memory than eager.
3. Search keeps only a small memory advantage because the requested search index dominates the body.
4. When every capability becomes relevant, Ignition and eager retain the same body.
5. Warm benefit must amortize routing/state-validation cost. In the corrected dependency sample, Ignition-warm crossed direct-cold at observed iteration 4.
6. Breadth growth eventually fills the cache, so eager can be just as appropriate.

### v0.05 - adaptive Governor

The Governor chooses among:

```text
direct-cold
Ignition-cold
Ignition-warm
eager-warm
```

Inputs currently include:

- route breadth
- route reuse
- measured per-capability bytes
- cache budget
- retained cache contents
- canonical state-change rate

Policy examples:

- first narrow route -> direct-cold
- repeated narrow route that fits budget -> Ignition-warm
- repeated broad route that fits budget -> eager-warm
- body larger than cache budget -> stay cold
- high state churn -> avoid warm retention

The first Governor benchmark exposed a large orchestration cost. Inspection showed canonical state was fingerprinted in the Governor and then fingerprinted again inside the selected path.

That failed efficiency shape is preserved in:

- `evidence/ignition-v0.05-governor-pre-fingerprint.json`

The repaired Governor computes the canonical fingerprint once and hands it into the chosen direct/cold/warm path. A dedicated test proves selected execution receipts reuse that fingerprint.

GitHub Actions run `33332165101` passed **27/27 tests** plus all previous benchmarks and the adaptive Governor benchmark.

Observed post-repair samples:

| Case | Governor policy | Governor total | Fixed comparison | Final cache |
| --- | --- | ---: | --- | ---: |
| narrow-repeat, 12 | 1 direct + 11 Ignition-warm | **150.76 ms** | direct 155.78 / Ignition-warm 149.56 / eager-warm 227.90 | 39,728 B |
| search-tight-cache, 5 | 5 direct-cold | **302.75 ms** | direct 354.88 / unconstrained Ignition-warm 143.52 | 0 B |
| report-high-cache, 6 | 1 Ignition-cold + 5 eager-warm | **176.76 ms** | direct 470.20 / Ignition-warm 166.29 / eager-warm 169.11 | 962,268 B |
| report-tight-cache, 4 | 4 Ignition-cold | **250.85 ms** | warm retention refused by budget | 0 B |
| breadth-growth, 12 | direct/cold -> incremental Ignition-warm | **269.86 ms** | cache eventually reaches full body | 962,268 B |
| state-churn, 8 | 1 warm attempt then 7 direct-cold | **27.29 ms** | warm retention abandoned as truth changes | 0 B |

Important interpretation:

- The Governor is not an oracle. It may pay a measurement/learning tax before it knows what should stay warm.
- A cache budget may deliberately reject the fastest unconstrained mode.
- Repeated broad work can justify eager retention.
- Rapidly changing canonical truth can make retention wasteful.
- Sharing one canonical fingerprint removed a major avoidable overhead in this harness.

## Current supported claim

> In these deterministic harnesses, dormant capability materialization can reduce real derived runtime allocation, warm reuse can avoid repeated reconstruction, and an adaptive Governor can select or refuse retention based on measured workload/resource conditions while preserving exact outputs.

The architecture is explicitly conditional:

> **Use Ignition where dormant possibility or reusable derived state pays for the orchestration. Use direct/eager execution where it does not.**

## This does NOT prove

- software creates RAM, CPU cycles, energy, or free compute;
- universal runtime speedup;
- global Governor optimality;
- production-scale superiority;
- statistically established timing distributions from single hosted samples;
- optimal cache eviction;
- cheap partial invalidation after state mutation;
- that every AXM capability should be materialized this way.

## Run

```bash
npm test
npm run demo
npm run benchmark:memory
npm run benchmark:realistic
npm run benchmark:warm
npm run benchmark:governor
```

Evidence receipts:

- `evidence/ignition-v0.02-ci-memory.json`
- `evidence/ignition-v0.03-realistic-workload.json`
- `evidence/ignition-v0.04-warm-break-even.json`
- `evidence/ignition-v0.05-governor-pre-fingerprint.json`
- `evidence/ignition-v0.05-governor.json`

## Next evidence gate

Current state changes invalidate the entire warm cache.

Next research rung:

**deterministic dependency-scoped invalidation + value-aware eviction**

Instead of:

```text
anything changes -> discard every derived body
```

try:

```text
canonical change receipt
        -> identify affected source/state domains
        -> invalidate only dependent capability bodies
        -> retain untouched verified bodies
        -> enforce hard memory budget by measured reuse/value
```

Compare this against:

- current whole-state invalidation Governor
- fixed direct-cold
- fixed Ignition-warm
- fixed eager-warm

The eviction/invalidation policy must preserve exact result equivalence and may choose to drop everything when that is the safer/cheaper decision.

## Lane rule

See `AGENTS.md`.

> **1 AI CHAT = 1 LANE. NO SPREAD.**

Current lane: issue #2 / `axm/ignition-v0.01-materialization-core`.

## Evidence discipline

Do not promote proposals into verified capability. Keep baselines, counterexamples, failed runs, repairs, receipts, and benchmark evidence together so every improvement is compared against simpler execution.
