# Ignition v0.15 — Whole-process residual attribution

## Question

After v0.14 made the measured typed-array execution peak equal the declared live runtime-body peak, what still dominates the process memory envelope?

v0.15 does **not** optimize a new subsystem. It adds fresh-process, forced-GC lifetime checkpoints around the existing 64-segment, scalar-metadata report path.

The same deterministic report remains:

- result hash: `daa06e7e`
- total runtime bodies materialized: **147,572 B**
- declared live runtime-body peak: **39,820 B**
- retained cache after run: **0 B**

The run-time probe tracks process peaks without returning snapshots to the session, so no memory-snapshot array is retained inside the run receipt.

## Measurement stages

```text
Node/modules loaded
-> registry
-> session
-> canonical 2,500-file state
-> state fingerprint
-> report execution peak
-> result retained
-> session closed
-> result dropped
-> fingerprint variable dropped
-> canonical state dropped
-> framework objects dropped
```

Every checkpoint forces GC before reading `process.memoryUsage()` and V8 heap statistics.

These measurements are **separate overlapping envelopes**. RSS, heapTotal, heapUsed, external, and ArrayBuffer must not be summed into a fake additive total.

## Canonical fixture

- files: **2,500**
- packages: **25**
- source characters: **1,014,151**
- source UTF-8 bytes: **1,014,151**

The fixture is ASCII in this benchmark, so source characters and UTF-8 bytes are equal.

## Absolute median stages

| stage | RSS | heapUsed | heapTotal | external | ArrayBuffer |
|---|---:|---:|---:|---:|---:|
| modules loaded | 54,222,848 B | 4,183,448 B | 6,922,240 B | 1,652,118 B | 18,843 B |
| registry created | 57,630,720 B | 4,212,896 B | 7,184,384 B | 1,605,633 B | 18,843 B |
| session created | 57,761,792 B | 4,217,008 B | 7,184,384 B | 1,605,633 B | 18,843 B |
| canonical state created | 61,562,880 B | 5,852,768 B | 10,854,400 B | 1,605,633 B | 18,843 B |
| fingerprint retained | 67,403,776 B | 5,680,968 B | 15,572,992 B | 1,605,633 B | 18,843 B |
| run result retained | 69,898,240 B | 5,917,680 B | 15,572,992 B | 1,665,906 B | 18,843 B |
| all state/framework refs dropped | 69,898,240 B | 4,457,704 B | 14,000,128 B | 1,665,906 B | 18,843 B |

The process-level story is immediately different from the capability-body story.

## What is actually live?

### Framework objects

Creating the registry adds only **29,448 B heapUsed** median. Creating the session adds another **4,112 B heapUsed**.

RSS rises much more than those live-object numbers, which is why v0.15 does not interpret RSS deltas as direct object sizes.

### Canonical state

Creating the 2,500-file JavaScript state adds:

- **1,635,760 B heapUsed**
- **3,670,016 B heapTotal**
- **3,801,088 B RSS**

Later dropping the state recovers **1,441,192 B heapUsed** median, while RSS does not immediately fall.

This is evidence for this fixture/process representation only. It is not a universal cost for 2,500 files.

### Fingerprint stage

The current state fingerprint is:

```js
hashValue(value) = fnv1a32(stableStringify(value))
```

`stableStringify()` builds a complete deterministic serialization string before FNV hashing it.

At the fingerprint checkpoint, compared with the prior canonical-state checkpoint:

- RSS rises **5,812,224 B**
- heapTotal rises **4,718,592 B**
- post-GC heapUsed actually falls **171,800 B**

Therefore this is **not** evidence that the retained 8-character fingerprint itself costs megabytes. It is a high-water / heap-capacity observation around fingerprint construction. The source shape makes full serialization a strong candidate for the next experiment, but v0.15 does not yet claim it as the measured cause.

### Execution peak

Above the already-loaded framework + state + fingerprint baseline, the report's median execution peak is:

| field | additional peak |
|---|---:|
| ArrayBuffer | **39,820 B** |
| external | 100,093 B |
| heapUsed | 250,880 B |
| RSS | 2,695,168 B |

The ArrayBuffer peak is exactly the v0.14 declared live-body peak in all five samples. Its peak site is the 39,820 B symbol body in 5/5 samples.

After the run finishes, ArrayBuffer is already back at the process baseline because zero-retention streaming released the runtime bodies.

### Result/output lifetime

Dropping the complete run result/receipt recovers only **12,008 B heapUsed** median.

That means the small final outputs are not the dominant remaining live-memory cost in this fixture.

### Process high-water

After the result, fingerprint variable, canonical state, session, and registry references are all dropped:

- ArrayBuffer delta versus module-loaded boot: **0 B**
- external delta: **13,788 B**
- heapUsed delta: **274,256 B**
- heapTotal delta: **7,077,888 B**
- RSS delta: **15,638,528 B**

RSS stays high even though the explicit state/runtime bodies are gone. This is an allocator/runtime high-water observation. v0.15 does not claim those resident pages are permanently unreclaimable or uniquely attributable to Ignition.

## The ratio that changes the next question

The module-loaded Node process has median RSS **54,222,848 B** (51.71 MiB).

The fully prepared pre-run process has median RSS **67,403,776 B** (64.28 MiB).

The actual Ignition report's incremental typed-array peak is **39,820 B** (38.89 KiB), which is only about **0.059%** of that pre-run RSS envelope.

This does **not** mean the other 99.941% is waste. It includes Node/V8, loaded code, heap capacity, canonical state, allocator reserve, and other process infrastructure.

It does mean that, for this fixture, the capability body is no longer the dominant memory question.

## Datacenter implication boundary

A naive deployment model of:

```text
one sleeping capability
-> one Node process/container/runtime baseline
```

would bury a tiny active capability body underneath the host/runtime envelope.

The architecture becomes more interesting at fleet scale only if a system can safely amortize that already-paid runtime across many dormant logical capabilities, or otherwise reduce/process-share the host baseline.

That is a **research direction**, not a datacenter savings result. v0.15 measures one Node process on one hosted runner. It does not establish cloud density, energy savings, cost savings, container consolidation, or Big Tech fleet economics.

## Strongest supported claim

> In this deterministic Node workspace harness, v0.14's 39,820 B live ArrayBuffer execution peak remains exact, while v0.15 shows that canonical JavaScript state, V8 heap capacity/high-water behavior, and the Node process/runtime envelope dominate the larger process memory picture. After explicit runtime/state references are dropped, ArrayBuffer returns fully to baseline but RSS remains about 15.64 MB above the initial module-loaded snapshot.

## Truth boundary

v0.15 does **not** prove:

- RSS is additive with heap/external/ArrayBuffer
- every RSS increase is live application data
- the registry costs 3.4 MB because RSS rose by that amount
- the fingerprint string itself costs 5.8 MB
- all post-run RSS is memory leakage
- the OS can never reclaim retained RSS
- one Node process is the intended production deployment unit
- many logical capabilities can already share a host safely
- datacenter, fleet, energy, CPU, cloud-cost, or container-density savings

## Evidence

- `evidence/ignition-v0.15-whole-process-residual.json`
- measurement workflow: `33371638473`
- measured head: `e9e73fbdc1b01758bf1d600d116ba91021cc20c5`

## Next gate

**v0.16 streaming canonical fingerprint construction.**

The current hash path materializes a complete `stableStringify(state)` string before FNV-1a hashing it. v0.15 observed a large RSS/heapTotal high-water change around this stage without a retained-heap increase.

The next controlled experiment should compare:

```text
current:
state -> full stable serialization string -> FNV-1a

candidate:
state -> deterministic serialization tokens/chunks -> incremental FNV-1a
```

Requirements:

- exact hash equality for all supported values
- preserve key sorting and JSON primitive semantics
- representative Unicode/escaping tests
- no giant retained canonical serialization string
- fresh-process heapUsed/heapTotal/RSS attribution
- timing measured separately from forced-GC instrumentation
- counterexamples where streaming hashing is slower or provides no useful high-water reduction

No merge/CANON action is performed.
