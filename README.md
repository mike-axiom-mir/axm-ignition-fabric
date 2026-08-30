# AXM Ignition Fabric

Experimental AXM research branch for testing whether a software body can keep large capability/state possibility dormant, materialize only the workset required by the current event, execute within explicit resource bounds, merge the result deterministically back into persistent truth, and release the temporary workset.

## v0.01 research question

Can on-demand materialization reduce the active working set versus eager materialization **without changing deterministic results**?

## Core loop

```text
persistent truth + capability registry
        -> request / event
        -> relevance match
        -> materialize bounded workset
        -> execute relevant dependency closure
        -> verify / deterministic merge
        -> persist result
        -> release temporary workset
```

## Current proof harness

The first harness compares two modes over the same deterministic request:

- **Eager:** the full registered capability body is treated as materialized, but only the relevant dependency closure executes.
- **Ignition:** only that relevant dependency closure is materialized and executed.

The outputs must be identical. The experiment measures the difference in active materialized capability count and declared working-set estimates.

This is deliberately an early logical/materialization harness. It does **not yet prove physical RAM savings**. Later phases need real allocation and process/runtime measurements.

## Hard boundaries

This repository does **not** claim that software creates physical RAM, CPU cycles, electrical energy, or free compute. Any measured gain must come from avoiding unnecessary activation, reusing deterministic results, compacting derivable state, or scheduling real resources more efficiently.

## Run

Requires a current Node.js runtime.

```bash
npm test
npm run demo
```

## Lane rule

See `AGENTS.md`.

> **1 AI CHAT = 1 LANE. NO SPREAD.**

Current lane: issue #2 / `axm/ignition-v0.01-materialization-core`.

## Evidence discipline

Do not promote architecture proposals into verified capability. Keep baseline, tests, receipts and benchmark evidence together so improvements can be compared against simpler eager execution.
