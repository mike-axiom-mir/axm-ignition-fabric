# AXM Ignition Fabric v0.09
## Versioned canonical domain/body identity

Status: measured experimental rung, not CANON.

### Research question

Can a derived capability body prove that the specific canonical truth it depends on is unchanged even when the complete software state changed?

v0.09 replaces the single question:

```text
Did the whole state change?
```

with a finer deterministic contract:

```text
Which canonical source domains changed?
Which revisions/hashes does this body depend on?
Does this exact body-validity key still match?
```

### Identity model

The realistic workspace currently exposes seven source domains:

- metadata
- imports
- symbols
- tokens
- content-hash
- lint
- risk

A canonical domain identity contains a hash and lineage revision for each domain plus the whole-state hash.

A retained body stores only the validity vector for its declared source domains.

Examples:

```text
workspace-search-index -> tokens
workspace-dependency-index -> imports
workspace-metadata-index -> metadata
```

Therefore a path-only mutation can change the whole state and `metadata:vN` while leaving the search body's `tokens` validity key exactly unchanged.

### Safety rules

- unknown body/domain binding is not guessed valid;
- an unbound body is discarded when domain identity changes;
- a body whose required domain is missing is invalid;
- whole-state fallback remains available when granular identity is absent;
- body value/eviction policy cannot override identity validity;
- benchmark outputs are compared to fresh direct deterministic result hashes.

### Correctness repair found during v0.09

The older workspace-domain diff matched files by ID and could miss pure array reordering.

The current derived indexes are positional, so reordering files can change the actual index body even if every file object is individually unchanged.

v0.09 domain hashes now include:

```text
array position + file id + domain-specific signature
```

A reorder therefore changes the positional domain identities instead of silently reusing stale derived arrays.

### CI

Implementation head used for the measured benchmark:

`07ef22703ae6a02dcbd8a183a9fba6a908362d97`

GitHub Actions run:

`33337444905`

Result:

- 48/48 tests PASS
- all v0.01-v0.08 benchmark gates PASS
- versioned domain identity benchmark PASS

### Repeated benchmark design

Two mutation traces were measured:

1. six path-only transitions
2. six same-width import-target transitions

For each trace:

- 2,500 deterministic source files
- five fresh Node processes for monolithic mode
- five fresh Node processes for domain-identity mode
- same 900 KB value-aware retention budget
- direct deterministic truth established before runtime timing
- whole-state fingerprint construction measured separately
- domain-identity construction measured separately

The runtime timer deliberately excludes identity construction so cache behavior and identity-construction cost remain visible as separate mechanisms.

### Path-only result

Only `metadata` advanced from revision 1 to revision 7.

| measure | whole-state invalidation | versioned domain/body identity |
|---|---:|---:|
| runtime median | 420.05 ms | **83.61 ms** |
| materialized bytes median | 6,056,540 B | **1,030,220 B** |
| cache hits median | 0 | **6** |
| identity construction median | 113.05 ms whole-state fingerprint | **457.51 ms domain identity** |

Runtime-only delta:

- 336.43 ms observed median reduction
- 5,026,320 B less materialization
- 6 additional cache hits

But the naive domain identity builder costs about 344.46 ms more than the whole-state fingerprint.

If identity construction and cache runtime are charged synchronously in this harness:

```text
whole-state: 113.05 + 420.05 = 533.10 ms
domain:      457.51 +  83.61 = 541.12 ms
```

So the current naive domain-identity path is about **8.02 ms slower** end-to-end in this hosted median.

### Import-target result

Only `imports` and `content-hash` advanced from revision 1 to revision 7.

| measure | whole-state invalidation | versioned domain/body identity |
|---|---:|---:|
| runtime median | 408.52 ms | **72.83 ms** |
| materialized bytes median | 6,142,136 B | **1,115,816 B** |
| cache hits median | 0 | **6** |
| identity construction median | 110.73 ms whole-state fingerprint | **465.51 ms domain identity** |

Runtime-only delta:

- 335.69 ms observed median reduction
- 5,026,320 B less materialization
- 6 additional cache hits

But the naive identity builder costs about 354.79 ms more than the whole-state fingerprint.

Charged synchronously:

```text
whole-state: 110.73 + 408.52 = 519.25 ms
domain:      465.51 +  72.83 = 538.34 ms
```

So the current naive domain-identity path is about **19.09 ms slower** end-to-end in this hosted median.

### Interpretation

v0.09 validates the granularity mechanism but rejects the naive implementation as an end-to-end performance win.

The cache side benefits strongly from granular truth identity:

```text
whole software state changed
!=
all derived knowledge became false
```

However, rescanning the entire 2,500-file workspace seven different ways to rediscover which domains changed is too expensive.

That creates the next seam directly:

```text
CURRENT v0.09
mutation happens
-> rescan whole workspace
-> rebuild seven domain identities
-> discover only one/two domains changed

NEXT
trusted canonical mutation receipt already knows what changed
-> advance only affected domain revisions/hashes
-> leave all other domain identities untouched
-> no full semantic rescan
```

### Strongest supported claim

> Versioned canonical domain identities and per-body validity keys can preserve derived bodies across unrelated whole-state changes while maintaining exact deterministic outputs. In this harness they substantially reduce cache reconstruction, but the current full-scan identity construction is expensive enough to erase that runtime advantage when charged synchronously.

### Not proven

v0.09 does not prove:

- cheap domain identity generation;
- end-to-end speedup with the current full-scan builder;
- automatic semantic dependency discovery;
- production-scale superiority;
- globally optimal cache policy;
- created RAM or compute;
- free energy;
- universal speedup.

Five hosted samples are stronger than a single timing observation but are not a broad statistical performance distribution.

### Next evidence gate

Build **incremental canonical domain revisions**.

A trusted mutation/transition receipt should carry enough evidence to update only the affected domain identities:

```text
old domain identity
+ canonical mutation receipt
+ changed-domain digest(s)
-> new domain identity
```

Required proof:

1. unchanged domains are not rescanned;
2. changed-domain revisions advance deterministically;
3. resulting body-validity keys equal a full-scan reference identity;
4. wrong/stale mutation receipts are rejected;
5. missing evidence falls back to full recomputation or invalidation;
6. measure incremental identity update cost against whole-state hashing and current v0.09 full-domain scan.

No merge/CANON action is performed. Mike remains the merge gate.
