# Ignition v0.22 — Adaptive Truth Checkpoints Under a Hard Budget

## Question

Can Ignition choose which exact domain-hash checkpoints deserve persistent bytes from observed mutation value, rather than retaining no domain checkpoints, retaining every domain, or relying only on mutation frequency?

v0.22 tests this under a hard **20,000-byte domain-checkpoint residency budget** on the deterministic 2,500-file workspace.

This is a software experiment. It is not chip/PIM/datacenter evidence.

## Starting point

v0.21 established that one domain checkpoint costs 10,000 bytes at 2,500 files, two domains cost 20,000 bytes, and all seven realistic domains cost 70,000 bytes.

It also established that checkpoint value depends on both:

- **which domain changed**, and
- **where the changed file sits in the sequential canonical domain representation**.

A frequently changed domain near file zero can have almost no reusable prefix. A less-frequent domain changed near the tail can avoid almost all domain replay.

v0.22 therefore does not score checkpoints from mutation frequency alone.

## Adaptive Governor

`AdaptiveTruthCheckpointGovernor` starts with zero domain checkpoints and enforces a hard byte ceiling.

For an uncheckpointed changed domain, it records the observed full canonical replay cost and estimates the checkpoint opportunity from mutation position. For a retained checkpoint, it records the actual replay avoided by the checkpoint.

The recent-value window is four mutation steps.

A new checkpoint must also overcome a one-full-domain build-cost penalty before admission. This prevents a single attractive late mutation from immediately consuming persistent checkpoint bytes.

The policy is deterministic. No AI model chooses the checkpoint set.

```text
trusted point mutation
        ↓
exact v0.20 state truth advance
        ↓
measure changed-domain replay opportunity
        ↓
recent replay value - admission cost
        ↓
hard 20 KB checkpoint budget
        ↓
retain only the highest-value eligible domain truth
```

## Important v0.22 implementation boundary

Checkpoint-set replacement is intentionally simple in this rung.

When the selected domain set changes, v0.22 rebuilds the selected checkpoint set from current exact truth. That means a checkpoint for a domain that survives the selection change may still be rebuilt.

All rebuild work is charged:

- canonical characters consumed to construct checkpoint sets,
- bytes built,
- bytes evicted,
- reconfiguration count,
- wall-clock time.

This avoids giving adaptive retention a free migration mechanism that has not yet been implemented.

## Policies compared

Five fresh-process policies are measured:

1. **none** — no domain checkpoints.
2. **frequency** — static 20 KB selection based on mutation frequency.
3. **oracle** — future-aware relevant checkpoints, still constrained to 20 KB. This is a reference, not a realizable online policy.
4. **adaptive** — v0.22 recent-value Governor with a hard 20 KB residency limit.
5. **all-seven** — static 70 KB checkpoint set. This is explicitly over budget and exists only as a reference.

Every policy uses the same v0.20 state-fingerprint checkpoint path. State-fingerprint replay must remain identical within a scenario so the experiment isolates domain-checkpoint retention.

## Exactness contract

For each workload, every policy must end at exactly the same:

- legacy-compatible whole-state FNV hash,
- canonical character count,
- per-domain hashes,
- per-domain revisions.

The adaptive, frequency, and oracle policies must never retain more than 20,000 domain-checkpoint bytes.

The all-seven reference must report its full 70,000-byte body rather than being treated as budget compliant.

## Scenario A — frequency versus position

The workload intentionally makes mutation count misleading:

- six `metadata` path mutations occur at **file 0**,
- then four same-width import mutations occur at **file 2499**,
- the import mutations change `content-hash` + `imports`.

The frequent domain therefore has almost no checkpointable prefix value, while the less-frequent pair sits at the tail.

All policies end at exact state hash `6ecb4baf` and 1,284,934 canonical state characters. Whole-state fingerprint replay is exactly 7,711,531 characters for every policy.

| policy | max checkpoint bytes | domain replay chars | checkpoint build chars | charged domain work | median wall |
|---|---:|---:|---:|---:|---:|
| none | 0 | 1,264,975 | 0 | 1,264,975 | 111.345 ms |
| frequency | 20,000 | 1,063,603 | 186,421 | 1,250,024 | **101.413 ms** |
| oracle | 20,000 | **817,099** | 112,045 | **929,144** | 108.056 ms |
| adaptive | 20,000 | 1,041,037 | 112,045 | 1,153,082 | 113.156 ms |
| all-seven | 70,000 | 816,907 | 1,430,481 | 2,247,388 | 114.686 ms |

### What adaptive learned

The six first-file metadata mutations produced **zero recent checkpoint opportunity**. Metadata therefore never earned persistent bytes despite being the most frequently changed domain.

After the second late import mutation, at step 8, adaptive selected:

```text
content-hash + imports
20,000 bytes
```

The final adaptive selection therefore matches the oracle pair, not the frequency-based `[content-hash, metadata]` pair.

Adaptive versus no checkpoints:

- 223,938 fewer domain canonical characters replayed,
- 111,893 fewer charged canonical-work characters after checkpoint construction is included,
- but hosted median time was **1.811 ms slower**.

Adaptive versus frequency:

- 22,566 fewer replay characters,
- 96,942 less charged canonical work,
- but hosted median time was **11.743 ms slower**.

This is retained as a timing counterexample. Lower deterministic replay work did not guarantee a lower hosted wall-clock median in this short workload.

### All-seven counterexample

All-seven achieves only 192 fewer replay characters than the oracle pair, but pays 1,430,481 canonical characters to build its seven checkpoint bodies. Its charged work rises to 2,247,388 characters.

Under this workload, retaining every possible checkpoint truth is not close to optimal once construction cost is charged.

## Scenario B — workload phase shift

The second workload changes what is valuable over time:

1. four late import mutations at file 2499,
2. then five late metadata mutations at file 2499.

A useful online policy should first learn the import pair, then move its budget to metadata after the workload changes.

All policies end at exact state hash `620413c8` and 1,284,921 canonical state characters. Whole-state fingerprint replay is exactly 5,334 characters for every policy.

| policy | max checkpoint bytes | domain replay chars | checkpoint build chars | bytes built | charged domain work | median wall |
|---|---:|---:|---:|---:|---:|---:|
| none | 0 | 1,128,810 | 0 | 0 | 1,128,810 | 35.611 ms |
| frequency | 20,000 | 247,570 | 186,421 | 20,000 | 433,991 | 23.336 ms |
| oracle | 20,000 | **874** | 248,132 | 30,000 | **249,006** | **18.967 ms** |
| adaptive | 20,000 | 496,836 | **446,008** | **50,000** | 942,844 | 39.052 ms |
| all-seven | 70,000 | **874** | 1,430,481 | 70,000 | 1,431,355 | 30.958 ms |

### Adaptive selection timeline

Adaptive does respond to the phase shift:

```text
step 2: content-hash + imports
step 6: imports + metadata
step 8: metadata
```

The final checkpoint body is only 10,000 bytes and contains `metadata` only.

So the retention policy successfully:

- learned valuable tail import truth,
- admitted it under the hard budget,
- detected that import value became stale,
- admitted metadata,
- evicted old import truth,
- ended under budget with the now-relevant domain.

### But migration becomes the whale

The selection decisions are structurally useful, but the current replacement mechanism rebuilds surviving checkpoint truth.

During the phase shift:

- maximum resident domain-checkpoint bytes: **20,000**,
- cumulative checkpoint bytes built: **50,000**,
- bytes evicted: 20,000,
- reconfigurations: 3,
- checkpoint construction work: **446,008 canonical characters**.

The transition:

```text
[content-hash, imports]
        ↓
[imports, metadata]
```

should conceptually be able to preserve the existing `imports` checkpoint, evict `content-hash`, and build only `metadata`.

v0.22 instead rebuilds the selected set, so already-useful `imports` truth is reconstructed.

Later:

```text
[imports, metadata]
        ↓
[metadata]
```

should require only eviction. v0.22 still pays through its generic replacement path.

That migration tax is large enough that adaptive is:

- 3.441 ms slower than no domain checkpoints,
- 15.716 ms slower than the lucky static frequency policy,
- 20.085 ms slower than the oracle.

Adaptive still saves 185,966 charged canonical-work characters versus no checkpoints and 488,511 versus all-seven, but it does not win this measured workload overall.

## Why the static frequency policy is retained as a counterexample

The static frequency policy happens to hold `[content-hash, metadata]` throughout the phase-shift workload.

That is not globally informed, yet it is lucky here:

- `content-hash` helps half of the first import pair,
- `metadata` is already present when the later metadata phase begins,
- it avoids adaptive's learning and reconfiguration tax.

It therefore beats adaptive on both charged canonical work and hosted timing in this particular workload.

This result is important. v0.22 proves that a sensible online retention rule can still lose to a lucky static policy over a short sequence.

## Strongest supported claim

> In this deterministic 2,500-file tracked-workspace harness, a recent-value domain-checkpoint Governor preserved exact legacy-compatible state/domain truth while enforcing a 20,000-byte hard residency budget and distinguishing mutation frequency from checkpoint value. Six first-file metadata mutations earned zero retention opportunity, while later near-tail import/content-hash mutations caused the Governor to retain the relevant 20 KB pair; this reduced domain replay by 223,938 characters versus no domain checkpoints, although hosted median time was 1.81 ms slower after learning and build overhead. In a phase-shift workload the Governor correctly evicted stale import truth and ended with a 10 KB metadata checkpoint, but current selection changes rebuilt retained checkpoint sets, charging 50 KB cumulative checkpoint construction and 446,008 build characters; adaptive remained 3.44 ms slower than no checkpoints and substantially worse than both the oracle and a lucky static frequency policy. The retention policy is structurally valid, while selection migration/rebuild cost is the next bottleneck.

## What v0.22 does not prove

It does not prove:

- that adaptive checkpoint retention is universally faster,
- that this value window or admission rule is globally optimal,
- that mutation position alone predicts future workload value,
- that every state representation should use FNV checkpoints,
- that the current selection migration mechanism is efficient,
- any chip, PIM, datacenter, energy, fleet-density, or hardware-speed claim.

## Next gate — v0.23 retained checkpoint migration

The next experiment should keep the **v0.22 selection decisions unchanged** while replacing checkpoint-set reconstruction with delta migration.

Required transition semantics:

```text
old selected set -> new selected set

survives selection:
    reuse exact checkpoint records

newly admitted:
    build checkpoint records

evicted:
    drop checkpoint records
```

For the measured phase-shift timeline:

```text
[]
→ [content-hash, imports]       build 20 KB
→ [imports, metadata]          reuse imports, evict content-hash, build metadata 10 KB
→ [metadata]                   evict imports, build nothing
```

That should reduce cumulative checkpoint construction from 50 KB toward 30 KB while preserving:

- exact state/domain truth,
- the same hard 20 KB residency limit,
- the same v0.22 selection timeline,
- the same mutation-domain replay work.

The question for v0.23 is no longer which truth deserves to remain.

It is:

**Don’t rebuild truth you decided to keep.**
