# v0.18 — Shared-traversal adaptive fingerprint

## Research question

Can adaptive route selection and canonical fingerprinting share one object-graph traversal, eliminating v0.17's separate structural preflight, while preserving exact fingerprints and reducing total resource cost?

v0.17 large-value shape:

```text
capped structural preflight
-> choose streaming
-> restart from root
-> full canonical streaming hash
```

v0.18 candidate:

```text
one canonical traversal
-> retain canonical prefix while below 65,536 chars
-> threshold crossed
-> seed FNV from retained prefix
-> release prefix
-> continue the SAME traversal
```

The candidate preserves exact canonical hashes and reports `objectTraversalRestarts: 0`.

## Measurement run

GitHub Actions run `33376476561` passed:

- **98/98 tests**
- all historical gates through v0.17
- v0.18 shared-traversal gate

Measured implementation head: `cc37996e3dc4289ff48d8fef2b329313535e675b`.

All compared paths preserve the exact 2,500-file workspace fingerprint `7e77d21a`.

## 2,500-file result

| measure | v0.17 adaptive | v0.18 shared | shared effect |
|---|---:|---:|---:|
| conceptual structural node visits | 15,808 | 15,005 | **803 fewer** |
| object traversal restarts | 1 after preflight | 0 | removed |
| retained canonical prefix | none | 65,460 chars | added |
| timing median | **17.987 ms** | 19.759 ms | **1.772 ms slower** |
| heapUsed peak | **10,360 B** | 76,960 B | **66,600 B worse** |
| heapTotal peak | **4,456,448 B** | 4,718,592 B | **262,144 B worse** |
| RSS peak | 5,451,776 B | **3,653,632 B** | **1,798,144 B better** |

The structural simplification is real. The overall resource win is not.

At the threshold transition the shared implementation has retained 65,460 canonical characters and then feeds that prefix into FNV before continuing. The removed structural walk is replaced by a non-trivial prefix representation and handoff cost.

## Strict 500-file counterexample

At 500 files, shared traversal is worse on every primary recorded comparison:

| measure | v0.17 | v0.18 shared |
|---|---:|---:|
| timing median | **5.810 ms** | 7.529 ms |
| heapUsed peak | **14,184 B** | 80,736 B |
| heapTotal peak | **262,144 B** | 2,359,296 B |
| RSS peak | **1,179,648 B** | 1,703,936 B |

This is enough to reject the candidate as the live core path.

## Small-input counterexamples

The same prefix/chunk-building tax appears on small values:

- tiny 55-char object: 0.291 -> 0.387 ms; heapUsed 10,344 -> 18,088 B
- 100-file workspace: 2.839 -> 2.992 ms; heapUsed 62,424 -> 148,264 B

A one-pass traversal is not automatically a cheaper traversal strategy when the optimized monolithic serializer is already inexpensive.

## Giant primitive boundary

A 131,074-character primitive string has only one structural node, so v0.17's preflight is essentially O(1).

The current canonical streamer also emits the escaped primitive as one 131,074-character chunk. Therefore the 65,536-character prefix guard does **not** bound the retained representation for this shape.

Measured:

- v0.17: 4.275 ms, 148,760 B heapUsed peak
- shared: 3.940 ms, 280,040 B heapUsed peak

The shared path is slightly faster in that hosted sample but uses 131,280 B more heapUsed peak. This proves that object-graph streaming does not imply bounded primitive chunks.

## Decision

**v0.18 shared traversal is preserved but rejected for the live core.**

After measurement, `hashValue()` is restored to the sealed v0.17 adaptive fingerprint policy. The v0.18 implementation, tests, giant-string boundary and benchmark remain in-tree as falsification evidence.

This follows the Ignition rule:

> A simpler structural story is not enough. The replacement has to win the resource contract that motivated it.

## Strongest supported claim

> In this deterministic Node harness, shared-traversal adaptive hashing preserved exact v0.17 canonical fingerprints and route decisions while eliminating the separate structural preflight. On the 2,500-file fixture it avoided 803 structural node visits and lowered measured RSS peak by about 1.80 MB, but raised heapUsed peak by 66.6 KB and was about 1.77 ms slower. At 500 files it was worse on timing, heapUsed, heapTotal, and RSS. The candidate is therefore retained as evidence but rejected for the live core.

## Evidence

- `evidence/ignition-v0.18-shared-traversal.json`
- this report
- prior v0.02-v0.17 evidence remains intact

## Next gate

### v0.19 — mutation-maintained canonical size hints

The failure suggests the route decision should not manufacture another representation just to learn whether the canonical truth is large.

For canonical state that already changes through trusted mutation receipts, test maintaining deterministic canonical-size metadata alongside truth:

```text
canonical state / trusted mutation
-> maintain canonical size hint

fingerprint request
-> O(1) route decision from trusted size hint
-> v0.17 monolithic or streaming fingerprint
```

For arbitrary untracked values, v0.17 remains the conservative fallback.

Research question:

**Can route knowledge be maintained when truth changes, so hashing does not scan, serialize, or retain a prefix merely to decide how to hash?**

Do not claim datacenter, fleet, energy, cloud-cost or density savings from this rung.
