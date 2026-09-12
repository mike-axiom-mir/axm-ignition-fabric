# Public capability discovery

This lane makes the package capability introduced by the portable-consumer lane discoverable without turning discovery into execution authority.

## Boundary

The source of truth remains the package-local `axmCapability` descriptor in `package.json`, exposed executablely by `src/capability.js`.

`tools/generate-public-capabilities.mjs` validates that the executable descriptor exactly matches the package metadata, preserves the package's `EXPERIMENTAL` status, local/offline runtime boundary, empty runtime dependency list, Apache-2.0 declaration, and explicit no-CANON/no-auto-merge authority. It then generates:

- `registry/capabilities.jsonl` — one public-safe capability declaration;
- `registry/capabilities.receipt.json` — source Git-blob identities, registry SHA-256, compatibility pin, and authority/truth boundary.

`.axm/discovery-public.json` is an explicit opt-in to Discovery Buddy's public-safe scanner. It exports bounded discovery metadata only. It does not publish the npm package, install anything, execute the capability, select it for a consumer, merge a branch, or grant CANON status.

## Provenance

The compatibility target is Discovery Buddy PR #5 at exact head `1a94fc2481d1cfc9234dea7c86af4777126d3924`:

- marker contract: `axm.discovery-public/v1`;
- registry seam: `registry/*capabilit*.jsonl`;
- output contract: `axm.discovery-index/v0.1`.

No Discovery Buddy code is copied into Ignition Fabric and no runtime dependency is added. The CI bridge checks out that exact provider head only to prove interoperability.

## Verify locally

```bash
node tools/generate-public-capabilities.mjs --check
node --test tests/public-capability-discovery.test.mjs
npm test
```

The dedicated GitHub Actions workflow also runs the focused checks on Node 18 and 22, executes the package's real `describe` command, then runs the pinned Discovery Buddy scanner in public mode and exact-byte `verify` mode.

## Truth boundary

A discovery declaration proves that the declared source-backed interface exists at the checked revision. It is not runtime compatibility evidence for an arbitrary consumer, authorship authentication, release readiness, quality certification, automatic-selection permission, merge authority, or CANON.
