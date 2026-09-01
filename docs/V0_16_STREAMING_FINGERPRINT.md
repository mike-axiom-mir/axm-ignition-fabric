# Ignition v0.16 — Streaming canonical fingerprint construction

## Question

v0.15 observed a large heap-capacity / RSS high-water increase around the current whole-state fingerprint path:

```text
state
-> stableStringify(state)
-> complete canonical serialization string
-> FNV-1a
```

Can the exact same canonical character stream be fed directly into incremental FNV-1a without first materializing the complete serialization string?

## Controlled implementation

v0.16 adds a separate streaming implementation. It does **not** silently replace `hashValue()` globally in this rung.

The reference remains:

```js
fnv1a32(stableStringify(value))
```

The candidate performs:

```text
value
-> deterministic canonical character chunks
-> incremental FNV-1a state
-> identical 8-character hash
```

Object keys retain sorted order. JSON string escaping and current primitive/array/object behavior are preserved against the existing serializer as the oracle.

## Exactness gates

Tests compare the emitted canonical character stream and final hash for representative:

- null / booleans / numbers / strings
- Unicode and escaping
- nested objects
- sorted object keys independent of insertion order
- arrays and sparse arrays
- current `undefined` edge behavior
- the full 2,500-file workspace fixture
- unsupported top-level values, which continue to reject rather than inventing a canonical hash

The 2,500-file state remains exactly:

```text
canonical characters: 1,284,856
hash:                 7e77d21a
```

## Workspace memory result

Five fresh memory processes per method, with forced-GC checkpoints. Timing uses separate fresh processes without forced-GC instrumentation.

| measure | monolithic | streaming |
|---|---:|---:|
| canonical characters | 1,284,856 | 1,284,856 |
| chunks | 1 | 55,017 |
| largest chunk | **1,284,856 chars** | **466 chars** |
| heapUsed peak above baseline | 1,299,528 B | **23,360 B** |
| heapTotal peak above baseline | 8,892,416 B | **0 B** |
| RSS peak above baseline | 4,349,952 B | **655,360 B** |
| ArrayBuffer peak above baseline | 0 B | 0 B |
| timing median | **18.799 ms** | 22.498 ms |

Observed median peak differences:

- heapUsed: **1,276,168 B lower** with streaming
- heapTotal: **8,892,416 B lower** with streaming
- RSS: **3,694,592 B lower** with streaming

But the streaming implementation is about **3.698 ms slower** in this hosted workspace sample.

So this rung is not a universal speed win. It is a measured high-water tradeoff.

## Tiny-object counterexample

A 55-character canonical object makes the opposite decision boundary obvious.

| measure | monolithic | streaming |
|---|---:|---:|
| canonical characters | 55 | 55 |
| largest chunk | 55 | 8 |
| heapUsed peak | **0 B** | 4,448 B |
| RSS peak | 131,072 B | 0 B |
| timing median | **0.02666 ms** | 0.21657 ms |

The full string is already tiny. Streaming adds orchestration overhead and is roughly eight times slower in this micro-sample. Its RSS observation is smaller, but there is no meaningful heap high-water problem to solve.

This counterexample is deliberately retained.

## What v0.16 establishes

For the large deterministic workspace fixture, the complete canonical serialization does not need to exist as one live string in order to preserve the exact canonical fingerprint.

The strongest supported statement is:

> In this Node harness, streaming the same deterministic canonical UTF-16 character stream directly into incremental FNV-1a preserved the exact 1,284,856-character workspace fingerprint while reducing measured fingerprint-construction heapUsed peak from 1,299,528 B to 23,360 B and RSS peak from 4,349,952 B to 655,360 B. The streaming path was slower, and a tiny-object counterexample showed that monolithic hashing can remain the better choice when the canonical representation is already small.

## Truth boundary

v0.16 does **not** prove:

- streaming hashing is universally faster
- RSS reductions are portable across runtimes or operating systems
- heapTotal is an additive application object-size measure
- arbitrary JavaScript exotic values are exhaustively canonicalized
- `hashValue()` should immediately be replaced globally
- every large state should use the same chunk granularity
- datacenter, fleet, energy, or cloud-cost savings

The current serializer remains the semantic oracle for this rung.

## Evidence

- `evidence/ignition-v0.16-streaming-fingerprint.json`
- measurement workflow: `33372842460`
- measured head: `c816cfd908d5c7157971aad50b4ae7e569d301a4`

## Next gate

**v0.17 adaptive core fingerprint policy.**

The measured tradeoff is now clear:

```text
large canonical state:
streaming saves high-water memory, costs CPU

tiny canonical value:
monolithic is simpler and faster
```

The next falsifiable experiment should integrate both into the core behind a deterministic policy/crossover, for example:

```text
small / already-cheap canonical value -> monolithic
large canonical value                 -> streaming
```

Requirements:

- exact hash identity on every route
- no double serialization merely to decide the route
- deterministic threshold/policy evidence
- replay every v0.01-v0.16 gate
- measure crossover across several state sizes
- retain workloads where monolithic remains the winner
- no merge/CANON action unless explicitly requested
