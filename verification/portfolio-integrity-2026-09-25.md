# Align discovery metadata with the current repository license

Date: 2026-09-25 UTC

Base commit: `e02d59c1e5b4ba083b9fad585cc39431b39c0ed7`

The current LICENSE and LICENSE_BOUNDARY.md declare MPL-2.0, while package metadata or the public discovery generator still declared Apache-2.0. This repair aligns current metadata and its admission checks with the existing repository declaration, then regenerates the exact discovery receipt.

No LICENSE text, historical snapshot, third-party notice, donor source, runtime capability, execution authority or CANON state is changed. Historical license grants remain historical evidence.

## Verification

`npm test`: 180 tests passed. The pinned external reference-state-closure provider retains its historical Apache-2.0 expectation; only this repository's current metadata changed.
