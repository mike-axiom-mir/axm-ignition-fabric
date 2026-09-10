import test from "node:test";
import assert from "node:assert/strict";

import { CapabilityRegistry } from "../src/ignition-core.js";
import { IgnitionSession } from "../src/ignition-session.js";

function timeoutAfter(ms) {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ kind: "timeout" }), ms);
  });
}

test("re-entrant close from admitted work fails instead of deadlocking the owning session", async () => {
  let session;

  const registry = new CapabilityRegistry([
    {
      id: "self-close",
      match: (request) => request.kind === "self-close",
      run: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        await session.close();
        return { unexpectedlyClosed: true };
      },
    },
  ]);

  session = new IgnitionSession({ registry, mode: "ignition" });

  const outcome = await Promise.race([
    session.run({ request: { kind: "self-close" }, state: { revision: 1 } })
      .then(
        (value) => ({ kind: "resolved", value }),
        (error) => ({ kind: "rejected", error }),
      ),
    timeoutAfter(250),
  ]);

  assert.notEqual(outcome.kind, "timeout", "close() deadlocked waiting for the admitted operation that invoked it");
  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.error?.code, "AXM_SESSION_REENTRANT_CLOSE");
  assert.equal(session.closed, false, "rejected re-entrant close must not revoke the session");

  await session.close();
  assert.equal(session.closed, true);
  assert.equal(session.stateHash, null);
});
