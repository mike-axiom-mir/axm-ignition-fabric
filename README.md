# AXM Ignition Fabric

Experimental AXM research branch for testing whether a software body can keep large capability/state possibility dormant, materialize only the workset required by the current event, execute within explicit resource bounds, merge the result deterministically back into persistent truth, and release the temporary workset.

## v0.02 research question

Can on-demand materialization reduce the **real runtime allocation footprint** versus eager materialization **without changing deterministic results**?

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

The harness compares two modes over the same deterministic request:

- **Eager:** materialize the full registered capability body, then execute only the relevant dependency closure.
- **Ignition:** materialize and execute only the relevant dependency closure.

Both modes must execute the same relevant capabilities and produce the same deterministic result hash.

v0.02 adds real `Uint8Array` working bodies to the demo capabilities. Each materialization returns an exact allocation receipt derived from the allocated array's `byteLength`.

The isolated memory benchmark launches fresh Node processes with `--expose-gc` and records:

- `process.memoryUsage().arrayBuffers`
- `external`
- `rss`
- `heapUsed`

before materialization, after materialization and after release.

The strongest automated assertion is currently the ArrayBuffer working-set comparison because it directly tracks the allocated demo bodies and is less allocator/noise-sensitive than RSS.

## What this does and does not prove

Current evidence can prove, for this bounded harness:

- Ignition materializes fewer capability bodies for narrow requests.
- those bodies are real runtime allocations, not only declared estimates.
- eager and Ignition execute the same relevant capability closure.
- eager and Ignition produce the same result hash.
- released bodies can disappear from the live ArrayBuffer working set after references are dropped and GC runs.

This does **not** prove:

- software creates RAM, CPU cycles, energy or free compute;
- lower total RSS on every runtime/workload;
- lower CPU cost once materialization overhead is included;
- production-scale savings;
- universal superiority over ordinary eager architecture.

Any measured gain must come from avoiding unnecessary activation, reusing deterministic results, compacting derivable state, or scheduling real resources more efficiently.

## Run

Requires a current Node.js runtime.

```bash
npm test
npm run demo
npm run benchmark:memory
```

## Lane rule

See `AGENTS.md`.

> **1 AI CHAT = 1 LANE. NO SPREAD.**

Current lane: issue #2 / `axm/ignition-v0.01-materialization-core`.

## Evidence discipline

Do not promote architecture proposals into verified capability. Keep baseline, tests, receipts and benchmark evidence together so improvements can be compared against simpler eager execution.
