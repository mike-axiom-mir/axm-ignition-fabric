# v0.21 — Selective checkpointed domain truth

## Research question

Can the same trusted point mutation that already advances v0.20 state truth also reuse exact prefix checkpoints for the changed canonical domain hashes, without paying to checkpoint every domain?

The question is deliberately narrower than “can everything be cached?” The v0.21 test is whether **the right verified consequences can earn a small persistent checkpoint body while irrelevant checkpoints remain measurable waste**.

## Starting point

v0.20 already carries a 10,000-byte file-boundary FNV checkpoint body for the whole canonical state of the 2,500-file fixture. That body lets the exact existing state fingerprint reuse the unchanged prefix before a point mutation.

The remaining v0.10 domain path still rebuilt the complete canonical entry array for every changed domain hash.

For seven realistic domains, naively retaining one 32-bit checkpoint per file boundary would cost:

```text
7 domains × 2,500 files × 4 bytes = 70,000 bytes
```

v0.21 asks whether that 70 KB body is necessary.

## Mechanism

Each selected domain can carry its own exact FNV state immediately before every canonical domain-entry body.

```text
trusted point mutation
        |
        +-> v0.20 state checkpoint -> exact state fingerprint
        +-> maintained canonical size
        +-> existing mutation receipt
        |
        +-> changed domain has checkpoint?
              yes -> reuse unchanged domain prefix
                     replay changed entry + suffix
                     refresh downstream checkpoints
              no  -> exact full changed-domain fallback
        |
        +-> existing versioned domain identity
```

No new Merkle identity or alternative state hash is introduced. The externally visible hashes remain compatible with the existing canonical FNV truth.

## Exact truth contract

Every measured policy must end at the same:

- legacy-compatible state hash;
- exact canonical state character count;
- changed-domain receipt;
- per-domain hashes;
- per-domain revisions.

All policies retain the same 10,000-byte v0.20 state-fingerprint checkpoint body and report the same state-fingerprint replay work. The only intentional variable is domain checkpoint retention.

The 120-test suite also verifies:

- zero, one-domain, two-domain and seven-domain checkpoint bodies;
- repeated selective checkpoint refresh;
- last-file exact reuse;
- first-file no-prefix-skip counterexample;
- wrong-domain checkpoint behavior;
- 20 KB relevant import checkpoints matching the exact result of 70 KB full-domain checkpoints.

## Checkpoint bodies

| Policy | Persistent domain checkpoint body |
|---|---:|
| none | 0 B |
| one selected domain | 10,000 B |
| two selected domains | 20,000 B |
| all seven domains | 70,000 B |

These bytes are persistent checkpoint state, not free metadata.

## Path mutation: metadata is the only changed domain

### First file — retained counterexample

| Policy | Domain replay | Entries skipped | Median transition |
|---|---:|---:|---:|
| none | 136,091 chars | 0 | 22.450 ms |
| metadata only, 10 KB | 136,059 chars | 0 | 20.196 ms |
| all seven, 70 KB | 136,059 chars | 0 | 20.528 ms |

A first-entry change has no unchanged entry prefix to skip. The selected checkpoint saves only **32 canonical characters (~0.024%)**.

This is the required no-prefix-skip counterexample. v0.21 does not claim every checkpoint body pays for itself.

### Middle file

| Policy | Domain replay | Entries skipped | Median transition |
|---|---:|---:|---:|
| none | 136,091 chars | 0 | 15.319 ms |
| metadata only, 10 KB | **70,261 chars** | **1,250** | 13.233 ms |
| all seven, 70 KB | **70,261 chars** | **1,250** | 12.466 ms |

The 10 KB selective and 70 KB full policies perform the same exact deterministic changed-domain replay. Hosted timing happens to favor the full policy slightly in this sample; that is not treated as a universal speed ordering.

### Last file

| Policy | Domain replay | Entries skipped | Median transition |
|---|---:|---:|---:|
| none | 136,091 chars | 0 | 5.935 ms |
| metadata only, 10 KB | **79 chars** | **2,499** | **3.030 ms** |
| all seven, 70 KB | **79 chars** | **2,499** | 3.217 ms |

The metadata-only checkpoint avoids **136,012 canonical characters (~99.942%)** of metadata-domain replay.

Most importantly, **10 KB gives the exact same changed-domain replay work as 70 KB** because metadata is the only changed domain. The six unrelated checkpoint bodies do not improve this mutation's deterministic replay requirement.

## Near-end same-width import mutation

This mutation changes two domains:

```text
content-hash
imports
```

The whole-state canonical size remains exactly **1,284,856 characters**, while the exact state/domain truth changes.

| Policy | Domain checkpoint bytes | Domain replay | Entries skipped | Median transition |
|---|---:|---:|---:|---:|
| none | 0 B | 112,045 chars | 0 | 5.753 ms |
| wrong: metadata only | 10,000 B | 112,045 chars | 0 | 5.771 ms |
| relevant pair | **20,000 B** | **76 chars** | **4,998** | **3.183 ms** |
| all seven | 70,000 B | **76 chars** | **4,998** | 3.402 ms |

The relevant two-domain policy avoids **111,969 canonical characters (~99.932%)** of changed-domain replay.

The 20 KB relevant checkpoint body performs the **same exact deterministic changed-domain replay as the 70 KB all-domain body**.

### Wrong checkpoint control

The metadata-only checkpoint during the import mutation costs **10,000 persistent bytes** and saves:

```text
0 canonical characters
0 changed-domain entries
```

Its hosted median is also essentially unchanged/slightly worse: 5.753 ms without domain checkpoints versus 5.771 ms with the irrelevant metadata body.

That negative control is important. A checkpoint is not valuable merely because it exists. It must correspond to truth the mutation can actually reuse.

## What v0.21 supports

> In this deterministic 2,500-file tracked-workspace harness, exact file-boundary FNV checkpoints can be maintained selectively for canonical domain-entry hashes without changing the legacy state hash, canonical size, mutation receipt, domain hashes, or revisions. A last-file metadata mutation reduced metadata-domain replay from 136,091 to 79 canonical characters using a 10,000-byte metadata checkpoint body, exactly matching the replay work of a 70,000-byte seven-domain checkpoint body. A near-end two-domain import mutation reduced domain replay from 112,045 to 76 characters using 20,000 bytes, again exactly matching 70,000-byte full checkpoints. A wrong 10,000-byte metadata checkpoint during that import mutation saved zero domain characters. Checkpoint value is therefore domain- and position-specific; storing all possible checkpoint truth is not automatically optimal.

## What v0.21 does not support

This result does **not** establish:

- universal O(1) hashing;
- universal timing improvement;
- that all domains should always retain checkpoints;
- that the current 10 KB-per-domain granularity is optimal;
- chip, PIM or hardware speedups;
- datacenter, fleet-density, energy or cost savings.

FNV remains sequential. A checkpoint reuses only the canonical prefix before the changed entry; the changed entry and suffix remain replay work.

## Design consequence

The new rule is not “remember everything.”

It is:

> **Persist the truth that earns its bytes.**

A relevant checkpoint can eliminate almost all replay for a late mutation. The same number of bytes pointed at the wrong domain can eliminate none.

## Evidence

- `evidence/ignition-v0.21-domain-checkpoints.json`
- source measurement head: `f2d0da7bae8e68e5324df6e78f2b5b413afe7b3c`
- source GitHub Actions run: `33384107725`
- source job: `99462729456`
- source run: 120/120 tests and all 25 CI/evidence gates passed

## Next gate — v0.22 adaptive truth-checkpoint retention

v0.21 proves that checkpoint value depends on **which domain changes and where it changes**. The next step should stop choosing checkpoint domains manually.

Candidate v0.22 question:

> Can a hard-byte-budget Governor retain only the domain checkpoint bodies whose measured mutation history earns their bytes, while charging checkpoint construction/replacement cost and preserving exact fallback truth?

A useful deterministic benchmark should compare:

- no domain checkpoints;
- static all-seven checkpoints;
- oracle relevant checkpoints;
- an adaptive checkpoint Governor under a hard byte budget;
- mutation workloads where domain frequency and mutation position disagree.

The adaptive policy must be charged for building and replacing checkpoint bodies. Otherwise it would merely hide the cost of changing its mind.

**Truth determines what may be reused. Measured replay value determines what earns persistent checkpoint bytes.**
