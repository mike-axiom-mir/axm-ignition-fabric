# AXM Ignition Fabric

Experimental AXM research branch for testing whether a software body can keep large capability/state possibility dormant, materialize only the workset required by the current event, execute within explicit resource bounds, merge the result deterministically back into persistent truth, and release the temporary workset.

## v0.03 research question

Does on-demand materialization still reduce real runtime allocation and work when capability bodies contain **actual parsed/indexed state**, rather than synthetic memory blobs, while preserving deterministic results?

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

## Baselines

- **Eager:** materialize the full registered capability body, then execute only the relevant dependency closure.
- **Ignition:** materialize and execute only the relevant dependency closure.

Both modes execute the same relevant capabilities and must produce the same deterministic result hash.

## v0.02 physical allocation harness

The synthetic harness uses real `Uint8Array` working bodies and isolated child processes. It measures `arrayBuffers`, `external`, `rss`, and `heapUsed` before and after materialization. This established that dormant irrelevant capability bodies can reduce actual runtime ArrayBuffer allocation in the bounded fixture.

Allocator boundary: dropping runtime references does **not** guarantee immediate OS/backing-store memory return. Post-release process memory is therefore observational, not a pass/fail invariant.

## v0.03 realistic parsed/indexed workload

The realistic harness builds a deterministic 2,500-file software workspace and materializes derived capability bodies that do real work:

- metadata index
- dependency index parsed from imports
- symbol index parsed from exports
- token-occurrence search index
- duplicate-content hash index
- lint-marker index
- report risk projection

GitHub Actions run `33330862222` passed all tests and all six realistic comparisons.

Measured examples from that run:

| Request | Eager materialized | Ignition materialized | Bytes saved | Eager materialize | Ignition materialize |
| --- | ---: | ---: | ---: | ---: | ---: |
| dependencies | 7 | 1 | 922,540 | 101.70 ms | 1.94 ms |
| symbols | 7 | 1 | 922,448 | 96.38 ms | 5.52 ms |
| search | 7 | 1 | 124,548 | 92.55 ms | 74.31 ms |
| duplicates | 7 | 1 | 952,268 | 92.63 ms | 4.09 ms |
| lint | 7 | 1 | 959,768 | 97.64 ms | 0.50 ms |
| report | 7 | 7 | **0** | 92.29 ms | 93.25 ms |

All eager/Ignition result hashes were equivalent.

The report case is intentionally retained as a counterexample: when every capability body is relevant, Ignition has no materialization saving. One-run timing differences are not treated as statistically meaningful.

## Current supported claim

For these deterministic harnesses, keeping irrelevant capability bodies dormant can reduce actual derived runtime allocation while preserving exact results. In the parsed/indexed workspace test, narrow requests also substantially reduced materialization work. The advantage shrinks when the requested capability itself dominates the body and disappears when all capability bodies are required.

## This does NOT prove

- software creates RAM, CPU cycles, energy, or free compute;
- lower total RSS on every runtime/workload;
- immediate OS-level memory return after release;
- production-scale savings;
- universal superiority over eager software;
- a statistically established runtime speedup from one CI sample per scenario;
- warm-cache or repeated-run superiority.

## Run

Requires a current Node.js runtime.

```bash
npm test
npm run demo
npm run benchmark:memory
npm run benchmark:realistic
```

Evidence receipts:

- `evidence/ignition-v0.02-ci-memory.json`
- `evidence/ignition-v0.03-realistic-workload.json`

## Next evidence gate

Add warm/repeated execution and a direct specialized baseline to measure:

- allocation churn
- cache/reuse benefits
- orchestration overhead
- request-breadth break-even
- when eager/direct execution is actually cheaper

## Lane rule

See `AGENTS.md`.

> **1 AI CHAT = 1 LANE. NO SPREAD.**

Current lane: issue #2 / `axm/ignition-v0.01-materialization-core`.

## Evidence discipline

Do not promote architecture proposals into verified capability. Keep baselines, failed runs, repairs, receipts, and benchmark evidence together so every improvement can be compared against simpler execution.
