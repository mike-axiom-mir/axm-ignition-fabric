# AXM Ignition Fabric

Experimental AXM research branch for testing whether a software body can keep large capability/state possibility dormant, materialize only the workset required by the current event, execute within explicit resource bounds, merge the result deterministically back into persistent truth, and release or retain the temporary workset according to measured reuse.

## v0.04 research question

What happens when work repeats?

Does a state-bound warm materialization cache preserve exact results while reducing repeated rebuild work, and where does the advantage disappear compared with direct routing or eager retention?

## Core loop

```text
persistent truth + capability registry
        -> request / event
        -> relevance match
        -> materialize or reuse bounded workset
        -> execute relevant dependency closure
        -> verify / deterministic merge
        -> persist result
        -> retain useful state-bound bodies OR release them
```

## Evidence ladder

### v0.01 — logical materialization

Deterministic relevance matching, dependency closure, eager-vs-Ignition result equivalence, receipts, and release lifecycle.

### v0.02 — physical allocation harness

Real `Uint8Array` capability bodies and isolated child-process memory probes showed that dormant irrelevant bodies can reduce actual runtime ArrayBuffer allocation.

Allocator boundary: dropping runtime references does **not** guarantee immediate OS/backing-store memory return. Post-release process memory is observational, not a pass/fail invariant.

### v0.03 — realistic parsed/indexed workload

A deterministic 2,500-file software workspace materializes real derived state:

- metadata index
- dependency index parsed from imports
- symbol index parsed from exports
- token-occurrence search index
- duplicate-content hash index
- lint-marker index
- report risk projection

Narrow requests saved derived-state allocation and materialization work. The broad report retained an explicit **0-byte saving** counterexample because all seven bodies are relevant.

### v0.04 — warm reuse + direct/eager break-even

Four execution modes are compared over exact same result hashes:

- **direct-cold** — fixed direct route, rebuild only the requested derived body each request
- **Ignition-cold** — generic relevance/dependency route, rebuild requested body each request
- **Ignition-warm** — generic route with persistent state-bound materialization cache
- **eager-warm** — materialize the complete capability body once and retain it

GitHub Actions run `33331597801` passed **19/19 tests** plus all demo, physical-memory, realistic-workload, and warm/direct benchmark steps.

Observed hosted-run results:

| Scenario | Requests | Direct cold total | Ignition cold total | Ignition warm total | Eager warm total | Ignition cache | Eager cache |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| dependencies | 20 | 318.55 ms | 301.27 ms | **12.49 ms** | 102.20 ms | 39,728 B | 962,268 B |
| search | 8 | 678.68 ms | 633.76 ms | **89.99 ms** | 108.13 ms | 837,720 B | 962,268 B |
| report | 6 | 604.12 ms | 573.74 ms | 114.92 ms | **110.84 ms** | 962,268 B | 962,268 B |
| breadth | 12 | 539.36 ms | 504.59 ms | **107.41 ms** | 122.65 ms | 962,268 B | 962,268 B |

Timing values are observations from one hosted run, not a statistical performance distribution.

Important findings:

1. Repeated narrow work can reuse the exact deterministic body. In the dependency test, the first Ignition-warm request materialized 39,728 bytes and the remaining 19 requests materialized **0 new bytes**.
2. Warm Ignition keeps a memory advantage only while the touched capability set remains narrow.
3. Search is a weaker case because the search index itself is most of the derived body.
4. The broad report needs every capability. Ignition-warm and eager-warm therefore retain exactly the same 962,268-byte body.
5. In that broad report sample, **eager-warm was slightly faster than Ignition-warm**. This is intentionally retained as evidence that Ignition should not become a universal mandatory mode.
6. A broad request sequence eventually touches every body, so Ignition's retained cache converges to eager size.
7. Cache entries are bound to the deterministic state hash. A changed workspace truth invalidates the warm cache and requires rematerialization.

## Current supported claim

For these deterministic harnesses, keeping irrelevant capability bodies dormant can reduce actual derived runtime allocation while preserving exact results. A state-bound warm cache can also eliminate repeated reconstruction of still-valid derived state.

The advantage is conditional:

> **Ignition helps when enough possibility can remain dormant or reused. If the current workload repeatedly needs the whole body, eager retention can be equally appropriate or cheaper.**

That conditional is now part of the architecture, not an exception to hide.

## This does NOT prove

- software creates RAM, CPU cycles, energy, or free compute;
- universal runtime speedup;
- lower total RSS on every runtime/workload;
- immediate OS-level memory return after release;
- production-scale superiority;
- statistically established timing distributions from single hosted samples;
- optimal cache eviction;
- cheap partial invalidation after state mutation;
- that Ignition should replace direct/eager execution everywhere.

## Run

Requires a current Node.js runtime.

```bash
npm test
npm run demo
npm run benchmark:memory
npm run benchmark:realistic
npm run benchmark:warm
```

Evidence receipts:

- `evidence/ignition-v0.02-ci-memory.json`
- `evidence/ignition-v0.03-realistic-workload.json`
- `evidence/ignition-v0.04-warm-break-even.json`

## Next evidence gate

The next rung should stop treating execution mode as a human-selected constant.

Build an **adaptive mode selector / ignition governor** that chooses among:

```text
direct cold
Ignition cold
Ignition warm
eager warm
```

using measured conditions such as:

- request breadth
- expected reuse
- cache hit rate
- current cache bytes
- materialization cost history
- state-change frequency
- memory budget
- orchestration cost

The governor must be benchmarked against fixed modes and must be allowed to choose **NOT IGNITION** when that is the cheaper grounded choice.

## Lane rule

See `AGENTS.md`.

> **1 AI CHAT = 1 LANE. NO SPREAD.**

Current lane: issue #2 / `axm/ignition-v0.01-materialization-core`.

## Evidence discipline

Do not promote architecture proposals into verified capability. Keep baselines, counterexamples, failed runs, repairs, receipts, and benchmark evidence together so every improvement can be compared against simpler execution.
