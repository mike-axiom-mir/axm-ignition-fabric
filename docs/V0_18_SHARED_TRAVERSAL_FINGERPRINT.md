# v0.18 — Shared-traversal adaptive fingerprint

## Research question

Can adaptive route selection and canonical fingerprinting share one object-graph traversal, eliminating v0.17's separate structural preflight, while preserving exact fingerprints and reducing total resource cost?

## Why this rung exists

v0.17 solved the fixed monolithic-versus-streaming choice, but a large value paid for two structural walks:

```text
capped preflight walk
-> choose streaming
-> restart
-> full canonical streaming walk
```

The obvious hypothesis was:

> Do not scan to decide how to scan.

v0.18 tests the smallest direct version of that hypothesis.

## Architecture

The live core `hashValue()` now uses a shared canonical traversal.

```text
one canonical traversal
        |
        v
buffer canonical characters while <= 65,536
        |
        +-- traversal finishes small
        |      -> hash compact canonical buffer
        |
        +-- threshold crossed
               -> feed retained prefix to FNV once
               -> release prefix
               -> continue the SAME traversal into FNV
```

The shared implementation reports:

- `traversalPasses = 1`
- `objectTraversalRestarts = 0`

The historical v0.17 implementation remains separately callable so this rung compares the previous two-pass policy against the new shared path without rewriting history.

## Exactness

The shared path must preserve all existing truth semantics.

The 98-test suite checks representative primitives, Unicode, sparse arrays, current undefined/function/symbol behavior, insertion-independent sorted keys, the existing 100-file/250-file route boundary, structural workset receipts, and rejection boundaries.

All 98 tests passed.

The full CI ladder also replayed every gate through v0.17 before the new v0.18 benchmark.

Implementation measurement run:

- head `cc37996e3dc4289ff48d8fef2b329313535e675b`
- GitHub Actions run `33376476561`
- job `99438986284`
- 98/98 tests
- 22/22 gates

## Benchmark design

Methods:

1. **v0.17**: capped structural preflight, then the selected historical monolithic or streaming hash.
2. **v0.18 shared**: one canonical traversal with an in-flight prefix-to-streaming transition.

Inputs:

- tiny object
- 25-file workspace
- 100-file workspace
- 250-file workspace
- 500-file workspace
- 2,500-file workspace
- giant primitive string

Each method/input uses:

- five fresh `--expose-gc` memory processes
- five separate fresh timing processes without forced-GC instrumentation

The memory probe checkpoints v0.18 while the prefix is still live and immediately after it is released. The prefix cost is therefore not hidden behind the completed hash.

RSS, `heapTotal`, `heapUsed`, `external`, and `ArrayBuffer` remain separate overlapping process envelopes and are not summed.

## Results

| input | chars | route | v0.17 ms | shared ms | timing change | v0.17 heap peak | shared heap peak |
|---|---:|---|---:|---:|---:|---:|---:|
| tiny | 55 | mono | 0.291 | 0.387 | **+0.096 ms** | 10,344 B | 18,088 B |
| 25 files | 11,954 | mono | 1.396 | **1.245** | **-0.151 ms** | 30,560 B | 49,816 B |
| 100 files | 48,989 | mono | **2.839** | 2.992 | **+0.152 ms** | 62,424 B | 148,264 B |
| 250 files | 124,636 | stream | **4.069** | 5.089 | **+1.021 ms** | 12,208 B | 80,128 B |
| 500 files | 251,133 | stream | **5.810** | 7.529 | **+1.719 ms** | 14,184 B | 80,736 B |
| 2,500 files | 1,284,856 | stream | **17.987** | 19.759 | **+1.772 ms** | 10,360 B | 76,960 B |
| giant string | 131,074 | stream | 4.275 | **3.940** | **-0.335 ms** | 148,760 B | 280,040 B |

Positive timing change means v0.18 is slower.

## What structurally succeeded

For the 2,500-file workspace:

- exact hash remains `7e77d21a`
- exact route remains `streaming`
- v0.17 preflight nodes: **803**
- full canonical traversal nodes: **15,005**
- v0.17 conceptual structural visits: **15,808**
- v0.18 structural visits: **15,005**
- v0.18 traversal passes: **1**
- v0.18 object traversal restarts: **0**

So the intended structural change is real: the separate 803-node preflight walk is gone.

## What failed

The one-pass implementation is not cheaper overall.

At 2,500 files:

- v0.17 timing: **17.987091 ms**
- shared timing: **19.759375 ms**
- shared is **1.772284 ms slower**
- v0.17 heapUsed peak: **10,360 B**
- shared heapUsed peak: **76,960 B**
- shared uses **66,600 B more heapUsed peak**
- shared `heapTotal` peak is **262,144 B higher**

The new cost is visible at the threshold transition:

- switch at canonical char **65,913**
- retained prefix **65,460 chars**
- crossing chunk **453 chars**

v0.18 eliminated a graph walk by manufacturing and retaining a ~65K canonical prefix, then feeding that prefix into FNV when the threshold was crossed.

**Less traversal is not the same as less work.**

## RSS disagrees with heap

At 2,500 files, hosted median RSS moved the other way:

- v0.17 RSS peak: **5,451,776 B**
- v0.18 RSS peak: **3,653,632 B**
- v0.18 is lower by **1,798,144 B**

This is preserved as a real observation, not used to erase the heap/time loss. V8 heap high-water and process RSS are different envelopes and can disagree.

The mixed cases reinforce that boundary:

- 250 files: v0.18 is slower and higher-heap, but RSS is 118,784 B lower.
- 500 files: v0.18 is slower, higher-heap, higher-heapTotal, and RSS is 524,288 B worse.

There is no single "memory wins" label supported by this rung.

## Small-input counterexample

For the tiny 55-character object, shared traversal is about 0.096 ms slower and uses 7,744 B more heapUsed peak.

For the 100-file 48,989-character workspace, shared traversal is about 0.152 ms slower and uses 85,840 B more heapUsed peak.

The reason is straightforward: v0.17 can cheaply preflight and then let the optimized monolithic serializer build the canonical string. v0.18 instead constructs the same small canonical representation incrementally from many chunks before hashing it.

One traversal is not automatically the cheapest traversal strategy.

## Giant-string counterexample

The giant primitive string has 131,074 canonical characters but only one structural node.

v0.17's preflight therefore costs essentially one node visit. The current canonical streamer also emits the JSON-escaped primitive as one **131,074-character chunk**.

Measured:

- v0.17: 4.274637 ms, 148,760 B heapUsed peak
- shared: 3.939839 ms, 280,040 B heapUsed peak

The shared path happens to be faster in this hosted sample but uses 131,280 B more heapUsed peak.

This also proves that the current streaming abstraction is not universally bounded at the character-chunk layer.

## Strongest supported claim

> In this deterministic Node harness, shared-traversal adaptive hashing preserved exact v0.17 canonical fingerprints and route decisions while reducing the composite object graph to one instrumented traversal with zero restarts. The naive retained-prefix implementation did not improve overall cost: at 2,500 files it avoided 803 structural preflight node-visits but was about 1.77 ms slower and used about 66.6 KB more heapUsed peak than v0.17, while measured RSS was about 1.80 MB lower. Therefore removing a traversal did not reduce total work because prefix construction and retention became the new dominant adaptation tax.

## What v0.18 does not prove

It does not prove:

- shared traversal is globally better than v0.17
- fewer object-graph visits imply lower CPU time
- RSS and heap high-water move together
- 65,536 is an optimal threshold
- a growing string is an optimal prefix spool
- canonical streaming chunks are bounded for arbitrary primitive strings
- five hosted samples define production behavior
- datacenter, fleet, energy, cloud-cost, CPU, or density savings

## Evidence

- `evidence/ignition-v0.18-shared-traversal-fingerprint.json`
- this report
- prior v0.02-v0.17 evidence remains intact

## Next gate

### v0.19 — bounded prefix spool strategies

The structural idea survived; the prefix representation did not.

Current v0.18:

```text
canonical chunks
-> repeated growing-string prefix up to ~65K
-> threshold
-> hash prefix
-> continue streaming
```

Next compare several ways to retain one object traversal without paying the growing-string tax:

- v0.17 two-pass adaptive reference
- v0.18 growing-string prefix
- chunk-array prefix, joined only if the value finishes small
- chunk-array prefix fed directly to FNV if it becomes large
- potentially direct streaming with only very cheap shallow fast paths

The gate must retain the same tiny, 100-file, 250-file, 500-file, 2,500-file, and giant-string counterexamples.

> **Do not delete one scan by manufacturing a more expensive intermediate.**
