# Ignition v0.13 — Segmented Oversized Search Capability

## Research question

Can an oversized deterministic capability stop defining the active-memory floor when one request only needs a deterministic partition of that capability?

v0.12 reduced a seven-body report from a 962,268 B whole-closure live body to an 837,720 B streamed live-body peak. The remaining floor was the atomic `workspace-search-index` body.

v0.13 tests whether that search capability itself can be materialized as a request-specific hash-prefix segment.

## Mechanism

The query is hashed deterministically. Its hash prefix selects one partition. While scanning canonical source tokens, only token/file pairs whose hash belongs to that partition are collected into the search runtime body.

```text
query
-> deterministic query hash
-> hash-prefix segment id
-> scan canonical tokens
-> retain pairs from requested segment only
-> sort segment
-> execute exact search inside segment
-> release after use
```

The search result remains the same because every occurrence of one exact query hash belongs to the same deterministic partition.

v0.13 intentionally uses **zero retention** for segmented search. The existing cache is capability-keyed, while a search segment is request-specific. Reusing one query segment for a different query would be incorrect. Request-bound segment cache identity is outside this rung.

## Correctness gates

The implementation proves exact monolithic equality for six query shapes:

- `ignite`
- `deterministic`
- `workspace`
- `module`
- `truth`
- a missing query

It also proves:

- segmented full-report output equals the monolithic report output;
- `segmentBits=0` reproduces the no-segmentation baseline;
- the segmented search body remains bound to the canonical `tokens` source domain;
- a segment materialized for one query is rejected if used for another request segment;
- a concentrated-token fixture gets no body reduction when all relevant tokens occupy the same partition.

## Physical sweep

Measurement workflow: GitHub Actions run `33348126397` on head `a68b37a80f568adf631c4215b7806a7b9049d48f`.

The 2,500-file seven-body report was tested at 1, 4, 16 and 64 deterministic search partitions. Each level used five fresh memory processes with forced-GC checkpoints and five separate timing processes without GC instrumentation.

All configurations produced report hash `daa06e7e`.

| partitions | search body | total runtime bodies materialized | declared live-body peak | measured ArrayBuffer peak | wall median |
|---:|---:|---:|---:|---:|---:|
| 1 | 837,720 B | 962,268 B | 837,720 B | 837,720 B | 130.09 ms |
| 4 | 265,560 B | 390,108 B | 265,560 B | 797,982 B | 90.33 ms |
| 16 | 89,984 B | 214,532 B | 89,984 B | 815,632 B | 79.65 ms |
| 64 | **23,024 B** | **147,572 B** | **39,820 B** | **782,322 B** | **75.48 ms** |

At 64 partitions, the search runtime body is no longer the largest declared runtime body. The 39,820 B symbol index becomes the declared live-body floor.

## The important discrepancy

The declared runtime-body result looks dramatic:

```text
search body
837,720 B
-> 23,024 B

reported live-body peak
837,720 B
-> 39,820 B
```

But the measured typed-array backing-store peak does **not** follow it down to 39,820 B:

```text
measured ArrayBuffer peak
837,720 B
-> 782,322 B
```

Peak attribution explains where the physical measurement moved.

At the one-partition baseline, the ArrayBuffer peak occurs after materializing `workspace-search-index` in all five samples.

At 4, 16 and 64 partitions, the ArrayBuffer peak occurs after materializing `workspace-metadata-index` in all five samples.

So segmentation succeeds at removing the search runtime body as the dominant declared body. A different construction-time allocation then becomes the dominant physical ArrayBuffer peak.

This is not reported as a 39,820 B physical-memory result. It is not one.

## What is and is not established

Supported:

> In this deterministic workspace harness, request-specific hash-prefix segmentation reduced the search runtime body from 837,720 B to 23,024 B at 64 partitions while preserving exact report output. Declared live runtime-body peak fell from 837,720 B to 39,820 B. Measured ArrayBuffer peak fell more modestly to 782,322 B because `workspace-metadata-index` became the dominant measured materialization peak.

Not established:

- universal segmentation benefit;
- universal physical RAM reduction;
- a 39,820 B physical process peak;
- request-safe segment retention or caching;
- automatic partition selection;
- universal speedup;
- the exact internal line responsible for the metadata construction peak;
- production-scale superiority.

The hosted timing sweep improved as segmentation increased, but these remain workload-specific observations. The implementation still scans the canonical source tokens to construct the requested segment, so no general complexity claim is made.

## Counterexample

A deterministic fixture whose search data is concentrated into one hash partition produces no search-body reduction from segmentation.

That boundary matters:

```text
data has useful partition structure
-> segmentation can shrink requested body

data concentrated in one required partition
-> segmentation has nothing to remove
```

## Next evidence gate

v0.14 should attack **construction-time / temporary allocation**, starting with `workspace-metadata-index` because peak attribution identifies it as the dominant ArrayBuffer phase once search is segmented.

The next research question is:

> Can metadata materialization preserve exact output while avoiding the temporary backing-store peak that remains invisible in the final 27,500 B metadata runtime body?

The exact internal source of that temporary peak must be isolated experimentally before replacing or naming it as the cause.

No merge or CANON action is part of v0.13.
