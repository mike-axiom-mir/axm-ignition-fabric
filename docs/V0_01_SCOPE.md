# Ignition Fabric v0.01 scope

## Research question

Can a software body keep most capability/state possibility dormant, materialize only the workset required by the current request, execute it within explicit resource bounds, deterministically merge the result back into persistent truth, and release the temporary workset while preserving the same output as an eager baseline?

## Core loop

```text
persistent truth + capability registry
        -> request/event
        -> relevance match
        -> materialize bounded workset
        -> execute
        -> verify
        -> deterministic merge
        -> persist new truth
        -> release workset
```

## v0.01 proof target

Implement two equivalent execution modes over the same deterministic task set:

1. **Eager baseline**: instantiate/register all available capabilities for the run.
2. **Ignition mode**: materialize only the capabilities matched by the current request/state.

Both modes must produce exactly equivalent deterministic results.

Measure:
- peak active capability count
- peak estimated working-set bytes
- execution time
- materialization overhead
- merge overhead
- result equivalence
- cache/reuse hits if implemented

## Hard boundaries

This prototype does not claim software can create physical RAM, CPU, energy, or free compute. Any benefit must come from less active state, less initialization, less repeated work, deterministic reuse, or better scheduling of real hardware.

## First harness

Use a small deterministic capability registry with mixed workloads:
- integer transform
- bounded array transform
- string/token transform
- state lookup
- deterministic reduction
- composite task that activates a subset

Every capability declares:
- id
- input predicate
- input/output schema
- deterministic flag
- resource estimate
- dependencies
- execution function

The scheduler returns a materialization receipt describing exactly what was activated and why.

## Acceptance

v0.01 passes only if:
- eager and ignition outputs are byte-for-byte equivalent for the same inputs
- relevance matching is deterministic
- temporary capabilities are released after completion
- the active workset is measurably smaller on at least one mixed workload
- no performance claim is made without benchmark evidence
- receipts expose activated capabilities, resources, merge result and release state
