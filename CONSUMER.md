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
npm install --offline /path/to/axm-ignition-fabric-0.0.23.tgz
axm-ignition describe
axm-ignition demo
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

The package intentionally excludes benchmark evidence, research prose, tests,
and probe scripts. Those remain in the repository for review. The package is
still marked `private`, so this lane enables local tarball handoff without
publishing a registry release or claiming a stable 1.0 contract.
