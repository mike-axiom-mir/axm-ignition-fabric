import test from "node:test";
import assert from "node:assert/strict";

import { CapabilityRegistry } from "../src/ignition-core.js";
import { IgnitionSession } from "../src/ignition-session.js";

function timeoutAfter(ms) {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ kind: "timeout" }), ms);
  });
}

test("release hook cannot join terminal close that is waiting for the same hook", async () => {
  let session;
  let nestedCloseOutcome = null;

  const registry = new CapabilityRegistry([
    {
      id: "release-self-close",
      match: (request) => request.kind === "release-self-close",
      materialize: async () => ({ instance: { alive: true }, allocatedBytes: 1 }),
      run: async () => ({ ok: true }),
      release: async () => {
        // Cross an asynchronous boundary so this contract depends on propagated
        // lifecycle ownership rather than synchronous call-stack inspection.
        await new Promise((resolve) => setImmediate(resolve));
        nestedCloseOutcome = await Promise.race([
          session.close().then(
            () => ({ kind: "resolved" }),
            (error) => ({ kind: "rejected", error }),
          ),
          timeoutAfter(250),
        ]);
      },
    },
  ]);

  session = new IgnitionSession({ registry, mode: "ignition" });
  await session.run({ request: { kind: "release-self-close" }, state: { revision: 1 } });

  const outerCloseOutcome = await Promise.race([
    session.close().then(
      () => ({ kind: "resolved" }),
      (error) => ({ kind: "rejected", error }),
    ),
    timeoutAfter(500),
  ]);

  assert.notEqual(outerCloseOutcome.kind, "timeout", "terminal close did not settle after release-hook re-entry");
  assert.equal(outerCloseOutcome.kind, "resolved", "terminal close should retain cleanup authority");
  assert.equal(nestedCloseOutcome?.kind, "rejected", "release hook must not join the close lifecycle waiting for that hook");
  assert.equal(nestedCloseOutcome?.error?.code, "AXM_SESSION_REENTRANT_CLOSE");
  assert.equal(session.closed, true);
  assert.equal(session.stateHash, null);
  assert.deepEqual(session.cachedCapabilityIds, []);
});
