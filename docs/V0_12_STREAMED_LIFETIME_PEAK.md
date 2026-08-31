# Ignition v0.12 — Streamed Lifetime-Aware Worksets

## Status

Observed research rung. Not CANON. No merge action is implied.

## Research question

v0.11 materialized all missing runtime bodies in a dependency closure before execution. v0.12 asks whether the same deterministic closure can execute with fewer runtime-body bytes simultaneously live.

Target:

```text
same required capabilities
same total materialization
same deterministic outputs
smaller simultaneously-live runtime-body set
```

## Mechanism

`StreamedWorksetSession` keeps deterministic dependency closure and topological order, but changes runtime lifetime:

```text
next ready capability
-> cache hit OR materialize runtime body
-> execute immediately
-> preserve output
-> retain runtime under cache policy OR release/null runtime reference
-> continue
```

Dependency outputs may survive after the dependency runtime body is released.

## Measurement boundary

Three measurements are kept separate:

1. **Total materialized bytes**: all runtime-body bytes built during the request.
2. **Declared live runtime-body bytes**: retained runtime cache plus the current newly materialized runtime body. Ordinary JS result/output object memory is excluded.
3. **Measured ArrayBuffer peak**: fresh `--expose-gc` child processes force GC at lifecycle checkpoints and record `process.memoryUsage().arrayBuffers`.

Normal timing runs are separate and do not use forced-GC instrumentation.

## Failure lineage

Initial workflow `33346848529` failed because the test variable `after` was scoped inside `try` and referenced in `finally`. That harness bug was repaired and remains part of the lineage.

Successful measurement workflow `33346982378` passed with **69/69 tests**, every prior evidence gate, and the streamed peak benchmark.

## Seven-body report

Fixture: 2,500 deterministic workspace files, zero retained cache for the peak comparison, five fresh processes per mode, result hash `daa06e7e`.

Both modes materialize exactly **962,268 B** in total.

| Measure | Whole closure | Streamed | Median delta |
|---|---:|---:|---:|
| Total materialized | 962,268 B | 962,268 B | 0 B |
| Declared peak live body | 962,268 B | **837,720 B** | **124,548 B lower** |
| Measured ArrayBuffer peak | 962,268 B | **837,720 B** | **124,548 B lower** |
| Node external peak | 962,272 B | 1,101,928 B | streamed worse |
| RSS peak | 18,202,624 B | 15,327,232 B | secondary/noisy |
| Normal wall time | **78.548 ms** | 78.726 ms | streamed ~0.178 ms slower |

The streamed ArrayBuffer samples had median 837,720 B, minimum 837,720 B, maximum 1,025,739 B.

## Current floor

The largest indivisible runtime body is the search index at **837,720 B**. Streaming removes simultaneous liveness of the smaller bodies, but cannot make this one atomic body smaller.

```text
whole closure peak  962,268 B
        ↓ streaming
current peak floor  837,720 B
        ↓ blocked by
largest atomic capability body
```

## Counterexample: one body

A dependency-index request requires one **39,728 B** runtime body.

Whole and streamed modes both show:

- total materialized: 39,728 B
- declared peak: 39,728 B
- measured ArrayBuffer peak: 39,728 B
- peak savings: **0 B**

Streaming cannot reduce peak body memory when the request needs only one indivisible body.

## Timing result

The report timing medians were essentially tied, with streamed execution slightly slower:

```text
whole closure  78.547683 ms
streamed       78.726045 ms
```

v0.12 therefore supports no speedup claim.

## External/RSS caution

Node's broader `external` metric was worse for the streamed report even though the ArrayBuffer peak fell. RSS also remains allocator/process-sensitive.

The supported wording is therefore **typed-array / ArrayBuffer live-set reduction in this harness**, not a blanket whole-process RAM claim.

## Preserved correctness rules

- deterministic dependency closure
- deterministic topological order
- exact result hashes
- per-body canonical domain validity
- stale truth removed before value decisions
- hard retained-cache ceiling
- incremental identity compatibility
- conservative fallback when evidence is missing
- deterministic cycle rejection

## Strongest supported claim

> In this deterministic typed-array workspace harness, streamed lifetime-aware workset execution reduced the median live ArrayBuffer peak for a seven-body report from 962,268 B to 837,720 B while materializing the same total 962,268 B and producing the same deterministic result hash. A one-body request showed zero peak savings. Normal hosted timing did not improve.

## Truth boundary

This does not establish universal RAM reduction, whole-process RSS reduction, external-memory reduction, universal speedup, zero overhead, arbitrary GC behavior, output-object memory reduction, or a peak below the largest indivisible required body.

## Next gate

The next measurable seam is **segmented oversized capability bodies**. The first candidate is the 837,720 B search index: split its runtime representation into deterministic partitions and test whether only required partitions can remain live while preserving exact results and receipts.
