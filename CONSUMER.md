# Consume the Ignition core locally

The bounded v0.06 library surface makes the proven materialization core usable
without repository-relative imports. It is dependency-free, local, and does
not need a network, account, cloud service, or AI model.

Build a local tarball from a reviewed source checkout:

```bash
npm pack --ignore-scripts
```

Install that tarball into another project without contacting a registry:

```bash
npm install --offline /path/to/axm-ignition-fabric-0.0.24.tgz
axm-ignition describe
axm-ignition demo
```

`demo` is human-readable by default: it shows exact-output status, the bodies
materialized for each request, the demo allocation difference, the executed
route, and the evidence boundary. Machine consumers can retain the original
one-receipt-per-line contract:

```bash
axm-ignition demo --json
axm-ignition demo --scenario heavy
```

Library consumers receive the deterministic capability registry, one-shot
executor, persistent session, canonical hashing helpers, and the v0.06
transition receipt/invalidation boundary:

```js
import {
  CapabilityRegistry,
  executeIgnitionRun
} from "axm-ignition-fabric";

const registry = new CapabilityRegistry([{
  id: "double",
  match: (request) => request.kind === "number",
  run: ({ request }) => request.value * 2
}]);

const run = await executeIgnitionRun({
  registry,
  request: { kind: "number", value: 21 },
  state: {},
  mode: "ignition"
});

console.log(run.result.double); // 42
```

## Optional Reference-state Closure research evidence

The package also exposes one deliberately provider-specific evidence adapter:

```js
import { runReferenceStateClosureEvidence } from
  "axm-ignition-fabric/reference-state-closure-evidence";

const receipt = runReferenceStateClosureEvidence({
  pyzPath: "/reviewed/path/reference-state-closure.pyz",
  providerSource: {
    repository: "mike-axiom-mir/axm-state-research",
    revision: "<reviewed 40-character git revision>"
  }
});
```

This does not discover, download, install, or select a provider. The caller
must deliberately supply a local regular `.pyz` file and its reviewed source
revision. The adapter independently hashes the artifact, asks the portable
provider to `verify`, `describe`, and `run`, then admits only the exact v1
software experiment contract and its default fixture evidence. Missing or
drifting providers return `HOLD`.

A passing `axm.ignition.reference-state-closure-evidence/v0.1` receipt is
**research evidence only**. It preserves the provider's software-only truth
boundary and does not establish Ignition performance, runtime superiority,
authenticated authorship, automatic execution authority, canonical-state
mutation, merge, or CANON authority.

The package intentionally excludes benchmark evidence, research prose, tests,
and probe scripts. Those remain in the repository for review. The package is
still marked `private`, so this lane enables local tarball handoff without
publishing a registry release or claiming a stable 1.0 contract.
