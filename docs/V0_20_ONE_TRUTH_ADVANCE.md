# Ignition v0.20 — One Mutation, One Truth Advance

## Question

Can one trusted point mutation advance exact canonical-size metadata, the existing canonical FNV state fingerprint, its mutation receipt, and the existing versioned domain identity from the same event, while preserving full recomputation as the truth oracle/fallback?

## Plain-English version

v0.19 learned the exact canonical size of a tracked workspace as mutations happened, so later fingerprint routing no longer had to rediscover that size by scanning the state.

But the state fingerprint itself still restarted from the beginning after every change.

v0.20 tests a narrower idea:

> Reuse the truth before the change; replay only the truth after it.

The external state hash is **not changed**. v0.20 remains byte-for-byte compatible with the existing canonical FNV fingerprint.

## Mechanism

The workspace keeps one 32-bit FNV checkpoint immediately before each canonical file body.

For 2,500 files this checkpoint body is:

```text
2,500 checkpoints × 4 bytes = 10,000 bytes
```

A supported point mutation becomes:

```text
trusted point mutation
        ↓
reuse FNV checkpoint before changed file
        ↓
hash changed file + canonical suffix
        ↓
refresh downstream FNV checkpoints
        ↓
exact legacy-compatible state hash
        ↓
advance exact canonical-size hint
        ↓
create existing point-mutation receipt
        ↓
advance existing v0.10 domain identity
```

The same mutation event therefore advances:

- canonical representation size
- exact state fingerprint
- mutation receipt
- versioned domain identity

## Exact truth contract

Every measured v0.20 result is checked against the sealed v0.19/reference path for:

- exact canonical FNV state hash
- exact canonical character count
- exact changed-domain receipt
- exact per-domain hashes
- exact per-domain revisions

Additional tests cover:

- first, middle, and last file mutations
- repeated checkpointed mutations
- Unicode and JSON escaping compatibility
- same-width import mutations
- structural-envelope rejection

The source run passed **114/114 tests** and all **24 evidence gates**.

## Measured results

Five fresh Node processes were used per method/scenario. Initial workspace/bootstrap/checkpoint construction and independent full-reference verification are outside the timing boundary.

| Mutation | v0.19 chars rehashed | v0.20 chars rehashed | v0.20 files skipped | v0.19 median | v0.20 median |
|---|---:|---:|---:|---:|---:|
| first file path | 1,284,860 | 1,284,833 | 0 | 23.008 ms | 21.348 ms |
| middle file path | 1,284,860 | 650,693 | 1,250 | 25.308 ms | 14.549 ms |
| last file path | 1,284,860 | 575 | 2,499 | 25.079 ms | 4.407 ms |
| same-width import near end | 1,284,856 | 1,084 | 2,498 | 25.182 ms | 5.350 ms |

The deterministic reuse curve is the important result.

### Middle file

A mutation at file 1,250 preserves the exact hash `7316a22f` while reducing fingerprint replay from:

```text
1,284,860 → 650,693 canonical characters
```

That avoids 634,167 canonical characters, about **49.36%** of the full fingerprint stream.

Observed transition timing moved from **25.308 ms** to **14.549 ms** in this hosted run.

### Last file

A mutation at file 2,499 preserves the exact hash `76accc6d` while reducing fingerprint replay from:

```text
1,284,860 → 575 canonical characters
```

That avoids 1,284,285 canonical characters, about **99.955%** of the full fingerprint stream.

Observed transition timing moved from **25.079 ms** to **4.407 ms**.

## First-file counterexample

The first-file mutation is intentionally retained as the near-no-benefit case.

The old path rehashes 1,284,860 canonical characters. The checkpointed path rehashes 1,284,833.

Only **27 characters** are structurally avoided.

That is expected. The implemented external FNV hash is sequential: a prefix checkpoint can skip the unchanged prefix, but when the changed file is at the front almost the entire canonical suffix still remains.

v0.20 therefore does **not** claim O(1) incremental hashing.

The hosted timing happened to improve by about 1.66 ms in this scenario, but that is not promoted as a structural speed claim because the deterministic work reduction is effectively zero.

## Same-width truth boundary

The same-width import mutation keeps canonical size exactly:

```text
1,284,856 → 1,284,856 characters
```

while state truth changes to hash `01d9ed74` and the `content-hash` and `imports` domain revisions advance.

The checkpointed path rehashes only 1,084 canonical characters across the last two files while preserving those exact domain identities.

This again separates three different facts:

```text
representation size ≠ state identity ≠ domain identity
```

One mutation event may advance all three without conflating them.

## Persistent checkpoint tax

The prefix reuse is not free.

The current 2,500-file implementation keeps a **10,000-byte Uint32Array** of FNV checkpoints.

That cost is explicit and persistent. It is not hidden as “metadata is free.”

This rung only establishes that a small persistent checkpoint body can buy large exact prefix reuse for sufficiently late mutations.

## What v0.20 does not prove

v0.20 does not prove:

- universal O(1) incremental state hashing
- that all mutations become cheap
- that checkpointing is always faster
- that the canonical suffix can always be skipped while preserving this exact hash contract
- a formal universal lower bound for FNV or other hashes
- a new Merkle/tree identity
- fleet/datacenter/energy savings
- a universal memory result

Ordinary untracked `hashValue(value)` remains the sealed v0.17 adaptive policy. The v0.20 checkpoint path is an opt-in tracked-workspace mechanism that earns reuse from trusted mutation history.

## Strongest supported claim

> In this deterministic 2,500-file tracked-workspace harness, one trusted point mutation can advance exact canonical-size metadata, the existing legacy-compatible canonical FNV state hash, its mutation receipt, and the existing versioned domain identity from one event. A 10,000-byte file-boundary FNV checkpoint body enables exact unchanged-prefix reuse: a middle-file path mutation reduced canonical fingerprint rehashing from 1,284,860 to 650,693 characters and median measured transition time from 25.31 ms to 14.55 ms; a last-file path mutation reduced rehashing to 575 characters with the exact same state/domain truth and measured 4.41 ms versus 25.08 ms. A first-file mutation preserved the near-no-benefit counterexample, saving only 27 canonical characters. Timing is hosted evidence, not universal performance.

## Evidence

- `evidence/ignition-v0.20-one-truth-advance.json`
- source implementation head: `053cfbe3fb93d893a4af66fe4fd00d0e300c3204`
- source GitHub Actions run: `33382269264`
- 114/114 tests PASS
- 24/24 evidence gates PASS

## Next gate

### v0.21 — checkpointed domain truth advance

v0.20 makes the state fingerprint position-aware, but changed domain hashes still rebuild their full canonical domain-entry arrays through the existing v0.10 machinery.

The next question is:

> Can the same trusted point mutation reuse exact prefix checkpoints for changed domain-entry hashes too?

This must keep the cost visible. A naive checkpoint body for all seven domains would be:

```text
7 domains × 2,500 files × 4 bytes = 70,000 bytes
```

That may or may not be worthwhile.

The next rung should therefore compare:

- no domain checkpoints
- selective changed/hot-domain checkpoints
- full seven-domain checkpoints

while preserving:

- exact domain hashes and revisions
- first-file near-no-benefit counterexample
- two-domain import mutation cost
- structural fallback
- explicit persistent checkpoint bytes

**A trusted mutation should advance consequences, not restart the universe.**
