# Ignition v0.17 — Adaptive core fingerprint policy

## Question

v0.16 proved a useful but conditional tradeoff:

```text
small canonical value -> monolithic is simpler and faster
large canonical value -> streaming avoids a large serialization high-water but costs CPU
```

v0.17 asks whether the live core can select between those paths deterministically **without first building the complete canonical string merely to decide which path to use**.

## Core integration

`hashValue()` now routes through the adaptive policy.

The historical reference remains available separately as `hashValueMonolithic()`.

The default policy threshold is **65,536 canonical lower-bound characters**.

Selection uses a capped structural lower-bound traversal. It counts enough canonical structure and raw string content to prove when a value must exceed the threshold, then stops. It does not call `stableStringify(value)` to make the decision.

```text
value
  |
  v
capped canonical lower-bound walk
  |
  +-- not proven > 65,536 --> monolithic hash
  |
  +-- proven > 65,536 ----> streaming hash
```

The threshold is an experimental memory high-water guard. It is **not** claimed to be the universally fastest crossover.

## Truth preservation

The adaptive route must always equal:

```js
hashValueMonolithic(value)
```

The expanded suite passed **91/91 tests** and every historical benchmark gate on workflow run `33374478332` before this evidence/report commit.

The 2,500-file workspace remains:

- canonical characters: **1,284,856**
- exact fingerprint: `7e77d21a`

No receipt/state/output hash migration occurred.

## Evidence-integrity repair

Core integration exposed an important historical-test trap.

The old v0.16 benchmark labelled one branch `monolithic`, but its timing path called the then-current `hashValue()`. Once `hashValue()` became adaptive, replaying that benchmark would silently measure adaptive behavior while calling it monolithic.

v0.17 fixes this by explicitly pinning historical experiments to `hashValueMonolithic()` where their original question requires it:

- v0.15 residual-attribution fingerprint stage
- v0.16 monolithic fingerprint oracle/timing path
- v0.16 exactness tests

Historical evidence therefore keeps its original semantics while the live core evolves.

## Measured crossover curve

Five fresh memory processes and five separate timing processes per mode/size were used.

| input | canonical chars | adaptive route | monolithic time | adaptive time | monolithic heapUsed peak | adaptive heapUsed peak | adaptive RSS saved vs mono |
|---|---:|---|---:|---:|---:|---:|---:|
| tiny object | 55 | monolithic | 0.122 ms | 0.335 ms | 1,632 B | 7,192 B | 0 B |
| 25 files | 11,954 | monolithic | 1.160 ms | 1.532 ms | 16,848 B | 28,800 B | 0 B |
| 100 files | 48,989 | monolithic | 3.312 ms | 3.740 ms | 48,648 B | 60,664 B | 102,400 B |
| 250 files | 124,636 | streaming | 3.996 ms | 5.982 ms | 112,712 B | 11,704 B | **-786,432 B** |
| 500 files | 251,133 | streaming | 5.976 ms | 6.988 ms | 221,928 B | 12,424 B | **-212,992 B** |
| 2,500 files | 1,284,856 | streaming | 21.222 ms | 23.646 ms | 1,112,888 B | 12,424 B | **2,297,856 B** |

Negative RSS saved means adaptive used more measured RSS in that hosted sample.

## The measured policy boundary

The largest measured workspace left on monolithic was:

```text
100 files
48,989 canonical chars
47,344 lower-bound chars
```

The first measured workspace moved to streaming was:

```text
250 files
124,636 canonical chars
65,901 lower-bound chars
```

The selector stopped early after **833 visited nodes** rather than needing to fully serialize the value.

At 500 files it stopped after 827 nodes; at 2,500 files after 803 nodes. Once the threshold is crossed, decision work therefore remains bounded by the threshold for this fixture instead of scaling through the entire workspace.

## Small-input counterexample

Adaptive policy is not free.

Tiny input:

```text
monolithic: 0.122 ms / 1,632 B heapUsed peak
adaptive:   0.335 ms / 7,192 B heapUsed peak
```

The adaptive preflight costs about **0.213 ms** and **5,560 B** extra heapUsed even though it correctly chooses monolithic.

At 25 and 100 files it likewise uses about 12 KB more heapUsed than direct monolithic and adds roughly 0.37–0.43 ms.

So the policy does not make the small path free. It protects larger values from representation high-water while accepting some selection overhead.

## Large-input result

At 2,500 files:

```text
monolithic fingerprint
heapUsed peak   1,112,888 B
heapTotal peak  6,008,832 B
RSS peak       12,926,976 B
median time        21.222 ms

adaptive fingerprint -> streaming
heapUsed peak      12,424 B
heapTotal peak  4,194,304 B
RSS peak       10,629,120 B
median time        23.646 ms
```

Observed adaptive savings versus monolithic:

- heapUsed peak: **1,100,464 B**
- heapTotal peak: **1,814,528 B**
- RSS peak: **2,297,856 B**

Observed timing cost: **+2.424 ms**.

The adaptive selector itself adds about 12.4 KB measured heapUsed and about 1.70 ms versus calling fixed streaming directly in this sample.

## The awkward middle

At 250 and 500 files adaptive clearly reduced heapUsed/heapTotal high-water but measured RSS was worse than monolithic:

```text
250 files: adaptive RSS +786,432 B vs monolithic
500 files: adaptive RSS +212,992 B vs monolithic
```

This is preserved rather than smoothed away. RSS is allocator/process behavior, not direct live-object accounting, and the five-sample hosted result does not justify claiming a monotonic RSS crossover.

## Strongest supported claim

> In this deterministic Node harness, integrating a 65,536-character capped structural lower-bound policy into core `hashValue()` preserved exact monolithic fingerprints across all 91 tests and historical gates, kept measured values through 48,989 canonical characters on the monolithic path, and selected streaming by the 124,636-character workspace. At 2,500 files it reduced measured fingerprint heapUsed peak by 1,100,464 B and RSS peak by 2,297,856 B versus monolithic at a 2.424 ms median timing cost. Tiny and small inputs showed that adaptive preflight itself adds heap and CPU, so the policy is a memory high-water guard rather than a universal performance optimum.

## Truth boundary

v0.17 does **not** prove:

- 65,536 characters is the optimal crossover
- adaptive is faster than both fixed paths
- RSS improves monotonically with streaming
- the lower-bound estimator is free
- all JavaScript exotic values are exhaustively canonicalized
- five hosted samples define production distributions
- Node/V8 behavior generalizes to other runtimes
- datacenter, cloud-cost, energy, CPU, or fleet-density savings

## Evidence

- `evidence/ignition-v0.17-adaptive-fingerprint.json`
- implementation measurement run: `33374478332`
- measured implementation head: `a97e37282c7d611df2bf7bc96fa153c29e80cf80`

## Next gate

**v0.18 shared-traversal adaptive fingerprinting.**

The remaining cost is obvious:

```text
large value:
preflight prefix walk
-> restart
-> full streaming traversal

small value:
complete preflight walk
-> restart
-> monolithic serialization
```

Research question:

> Can the adaptive decision and canonical hash share one traversal so the memory guard does not pay a separate scan merely to decide how to scan?

Or, more compactly:

**Do not scan to decide how to scan.**

No merge/CANON action is performed.
