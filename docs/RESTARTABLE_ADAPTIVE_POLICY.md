# Restartable adaptive checkpoint policy

## Structural boundary

The v0.23 adaptive checkpoint governor keeps two different kinds of state:

- **canonical workspace truth** — the workspace itself and its deterministic state/domain identities;
- **adaptive realization state** — recent opportunity windows, selected checkpoint domains, generation/counters, and the derived checkpoint arrays used to accelerate later truth advances.

Before this lane, all adaptive realization state lived only in process memory. Reconstructing a governor from the same canonical workspace after restart silently reset the value window, selected domains, generation, and policy accounting.

## Continuation contract

`AdaptiveTruthCheckpointGovernor.checkpoint()` now emits:

`axm.ignition-adaptive-truth-checkpoint-continuation/v1`

The continuation contains only the minimum policy state needed to continue the deterministic selection process:

- exact canonical `stateHash` and canonical character count;
- governor schema, budget, value window, bytes/domain and max-domain shape;
- generation and deterministic accounting counters;
- currently selected domains;
- fixed-size per-domain policy statistics and recent-opportunity windows;
- SHA-256 over the continuation payload.

It deliberately does **not** serialize:

- the canonical workspace;
- `Uint32Array` checkpoint storage;
- domain/fingerprint indexes;
- prior decision-history objects.

Those are not treated as another durable truth source.

## Restore

`AdaptiveTruthCheckpointGovernor.restore({ state, continuation })`:

1. validates the continuation schema and SHA-256;
2. rebuilds truth/index structures from the supplied canonical workspace;
3. requires the rebuilt state hash, canonical size and workspace shape to match the continuation;
4. reconstructs only the selected derived checkpoint arrays from canonical truth;
5. restores the adaptive value window, generation and policy counters;
6. starts a fresh in-process decision-history list;
7. returns a separate `resumeReceipt()` that records checkpoint reconstruction cost.

Checkpoint reconstruction is charged into the governor's build accounting. Restart therefore does not pretend that rebuilding derived arrays was free.

## Invariant

A valid continuation plus the exact canonical state must make the same subsequent adaptive selection decisions as an uninterrupted governor, while restart-specific reconstruction cost remains explicit.

## Truth boundary

The SHA-256 is content integrity, not author authentication. The continuation does not make derived checkpoint arrays authoritative, does not remove the need for the canonical workspace, and does not prove physical process-memory or wall-clock savings.

Bootstrap work for the canonical fingerprint/domain indexes is reconstructed during restore but is not currently exposed as a measured character/byte cost by those primitives. Only the selected checkpoint-array rebuild has explicit restore accounting in this lane.

No merge or CANON authority is added.
