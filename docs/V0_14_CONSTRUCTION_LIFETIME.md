# AXM Ignition Fabric v0.14 — Construction-Lifetime-Aware Metadata

Status: TESTED research rung

## Question

v0.13 reduced the request-specific search body from 837,720 B to 23,024 B, yet a 64-partition report still showed a median ArrayBuffer peak near 0.8 MB. Lifecycle attribution moved that peak to `workspace-metadata-index`.

v0.14 asks:

> Is that remaining typed-array peak caused by temporary allocation during metadata construction rather than by the persistent metadata body itself?

## Controlled change

The metadata body remains four typed arrays:

- file byte sizes
- path hashes
- package ids
- language codes

Persistent metadata size remains exactly **27,500 B**.

Only one construction operation changes.

Baseline:

```js
TextEncoder.encode(file.content).byteLength
```

Candidate:

```text
scalar UTF-8 byte-length count
without allocating a per-file ArrayBuffer
```

The scalar counter handles ASCII, multi-byte Unicode, surrogate pairs, and unpaired surrogates using the same replacement-byte accounting observed from `TextEncoder` in the tested cases.

## Correctness

The exact v0.14 code head passed **79/79 tests** before evidence sealing.

New tests prove:

- representative scalar UTF-8 byte lengths equal `TextEncoder`
- 2,500-file metadata arrays are byte-for-byte equivalent
- persistent metadata allocated bytes remain 27,500 B
- the full 64-segment seven-body report remains exactly `daa06e7e`
- construction mode is explicit and rejects unknown modes

## Metadata-only physical experiment

Five fresh `--expose-gc` Node processes per construction mode.

| measure | TextEncoder | scalar |
|---|---:|---:|
| persistent metadata body | 27,500 B | 27,500 B |
| declared live-body peak | 27,500 B | 27,500 B |
| measured ArrayBuffer peak | **809,646 B** | **27,500 B** |
| measured external peak | 1,041,655 B | 27,504 B |
| RSS delta median | 1,703,936 B | 262,144 B |
| normal wall median | **6.766 ms** | 7.391 ms |

ArrayBuffer peak reduction: **782,146 B**.

The scalar path is slightly slower in this metadata-only hosted timing sample. The memory win is therefore not represented as a universal speed win.

## Full 64-partition report

Search remains segmented at 64 hash-prefix partitions. Zero retention remains in use.

Both construction modes produce:

- report hash `daa06e7e`
- total declared runtime bodies **147,572 B**
- declared live runtime-body peak **39,820 B**

| measure | TextEncoder metadata | scalar metadata |
|---|---:|---:|
| measured ArrayBuffer peak | **808,449 B** | **39,820 B** |
| measured external peak | 1,041,655 B | 39,824 B |
| RSS delta median | 4,030,464 B | 2,613,248 B |
| heapUsed delta median | 116,280 B | 118,328 B |
| normal wall median | 74.348 ms | **72.664 ms** |

ArrayBuffer peak reduction: **768,629 B**.

Most importantly:

```text
scalar measured ArrayBuffer peak = 39,820 B
scalar declared live-body peak    = 39,820 B
physical typed-array gap          = 0 B
```

The peak site also moves from metadata construction to `workspace-symbol-index`, whose persistent body is the new largest live runtime body in this report.

## Interpretation

The controlled experiment supports this bounded conclusion:

> In this fixture, the large v0.13 metadata-phase ArrayBuffer peak was dominated by temporary typed-array backing stores created by repeated `TextEncoder.encode(file.content)` calls used only to obtain byte lengths.

Replacing that operation with an allocation-free scalar byte counter preserves the canonical outputs while allowing measured typed-array backing-store peak to converge to the declared live runtime-body peak.

This is a construction-lifetime result, not merely another cache result.

```text
possible body
-> selected body
-> streamed body lifetime
-> segmented body
-> construction temporary lifetime
```

Each previous reduction exposed the next physical cost layer.

## Truth boundary

v0.14 does not prove:

- whole-process RSS equals 39,820 B
- all JavaScript temporary allocation has been removed
- heap/output objects are negligible
- every use of `TextEncoder` is wasteful
- scalar UTF-8 counting is faster in every workload
- every software capability can be transformed this way
- universal RAM, CPU, or energy multiplication

The tested UTF-8 cases are representative correctness evidence, not an exhaustive standards-conformance proof over every JavaScript string.

## Next gate

Now that typed-array backing-store peak converges to the declared runtime-body peak, the next useful rung is **v0.15 whole-process residual attribution**.

Measure separately:

- JavaScript heap growth
- result/dependency output lifetime
- RSS versus allocator reserve
- runtime framework/session overhead
- canonical state/fixture footprint boundaries

The goal is not to force RSS to equal 39,820 B. The goal is to identify which remaining bytes are necessary truth/state/output and which are avoidable execution baseline.
