# Ignition Fabric v0.08 — Truth-Aware Hard-Budget Memory

## Research question

Can deterministic scoped invalidation and deterministic hard-budget retention operate in one lifecycle without confusing **truth validity** with **memory value**?

The intended order is:

```text
canonical transition receipt
        -> remove stale cached bodies
        -> preserve bodies still proven valid
        -> admit newly required bodies
        -> enforce hard byte ceiling
        -> evict valid low-value bodies only when necessary
        -> execute against the new canonical truth
```

A cache policy is never allowed to retain a body that the truth layer has marked stale merely because that body is expensive or frequently reused.

## Implementation

`BudgetedRetentionSession` now accepts an optional deterministic invalidation resolver and exposes `applyTransition(...)`.

A trusted transition must:

- match the session's current canonical `fromStateHash`;
- carry a valid receipt hash;
- resolve changed source domains into invalidated capability IDs;
- release those stale cached bodies before any later budget decision;
- advance the session to `toStateHash`.

Fallback remains conservative:

- state changes without a trusted transition receipt still invalidate the entire budget cache;
- a receipt for the wrong canonical base is rejected before cache mutation;
- unknown source-domain bindings continue to invalidate by default through the v0.06 resolver.

Current v0.08 execution scope remains deliberately narrow: exactly one dependency-free matched capability per request. This keeps the experiment focused on truth + cache policy interaction rather than multi-capability merge semantics.

## Verification

Implementation head tested: `706ec3ba940b8cc0afb6f71677063e1ee387b2a7`

GitHub Actions run `33334050971`: **PASS**

- 41/41 tests PASS
- deterministic demo PASS
- physical allocation benchmark PASS
- realistic 2,500-file parsed/indexed benchmark PASS
- warm/direct benchmark PASS
- adaptive Governor benchmark PASS
- scoped invalidation benchmark PASS
- hard-budget retention benchmark PASS
- truth-aware hard-budget benchmark PASS

## Integrated benchmark

Fixture:

- deterministic 2,500-file workspace
- 900,000-byte hard cache ceiling
- value-aware retention policy on both sides
- four canonical same-width import-target transitions
- each transition changes `imports` + `content-hash`
- cache is warmed before mutation with repeated search plus dependency, duplicate and lint bodies
- after each transition, requests deliberately add enough valid bodies to force real budget pressure
- direct-baseline verification and upstream transition-receipt generation are excluded from policy timing

### Full invalidation + hard budget

```text
total wall:               255.78 ms
total stale released:   3,560,068 B
total budget evicted:     268,912 B
total materialized:     3,829,072 B
cache hits:                       0
cache misses:                    24
final cache:               890,040 B
```

### Scoped truth + hard budget

```text
total wall:                44.39 ms
total stale released:      49,728 B
total budget evicted:     450,692 B
total materialized:       478,192 B
cache hits:                       4
cache misses:                    20
final cache:               867,720 B
```

### Observed delta

```text
stale release avoided:   3,510,340 B
materialization avoided: 3,350,880 B
extra real cache hits:            4
hosted wall delta:          211.39 ms
```

Every compared output remained exactly equivalent to the deterministic direct baseline.

## Important interpretation

Scoped truth produced **more budget-eviction bytes** than full invalidation in this trace:

```text
full invalidation budget evictions: 268,912 B
scoped truth budget evictions:      450,692 B
```

This is expected and useful evidence.

Full invalidation destroys valid expensive state before the cache policy can reason about it.

Scoped truth preserves the still-valid 837,720-byte search body. That body then competes for the same 900 KB ceiling with newly materialized valid bodies. The value policy therefore evicts more lower-value valid state to protect the expensive reused search body.

The architecture now has two separate deterministic questions:

```text
TRUTH GATE
Is this derived body still valid under current canonical truth?

VALUE GATE
If valid, is keeping it worth the scarce memory it occupies?
```

A value score cannot override the truth gate.

## Strongest supported claim

> In this deterministic workspace harness, truth-scoped invalidation and hard-budget retention can operate in one lifecycle: trusted hash-bound transition evidence removes stale derived bodies first, still-valid bodies remain eligible for retention, and deterministic budget eviction then chooses among valid bodies while preserving exact outputs and the hard memory ceiling.

In the measured transition trace, this substantially reduced reconstruction and preserved four additional cache hits versus full invalidation.

## Boundaries

This does **not** prove:

- universal speedup;
- production-scale superiority;
- globally optimal eviction;
- automatic arbitrary dependency inference;
- free transition-receipt generation;
- statistically established timing distributions from a single hosted sample;
- created RAM, compute cycles, energy, or free resources;
- that measured materialization time is a timeless intrinsic value signal;
- that the current single-capability execution restriction is sufficient for a general runtime.

Scoped correctness still depends on complete and truthful upstream changed-domain evidence.

## Next evidence gate

The next important seam is **granular identity**, not another cache score.

Current transition receipts still bind whole canonical state hashes. Research next:

```text
versioned canonical domains / body identities
        -> reuse trusted unchanged domain identities directly
        -> invalidate by explicit domain version transition
        -> reduce dependence on monolithic whole-state fingerprinting
        -> keep hard-budget truth/value ordering
```

Then extend the budgeted runtime from one dependency-free capability to dependency-aware multi-capability worksets and run repeated statistical samples before strengthening timing heuristics.
