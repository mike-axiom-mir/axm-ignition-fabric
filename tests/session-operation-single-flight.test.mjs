import test from "node:test";
import assert from "node:assert/strict";

import { CapabilityRegistry } from "../src/ignition-core.js";
import { IgnitionSession } from "../src/ignition-session.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function settle(promise) {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  );
}

test("a concurrent state-changing run cannot release a runtime still used by admitted work", async () => {
  const firstExecutionStarted = deferred();
  const allowFirstExecutionToFinish = deferred();
  const runtimes = [];
  let releaseCalls = 0;

  const registry = new CapabilityRegistry([
    {
      id: "runtime",
      match: (request) => request.kind === "use",
      materialize: ({ state }) => {
        const runtime = { revision: state.revision, released: false };
        runtimes.push(runtime);
        return { instance: runtime, allocatedBytes: 32 };
      },
      run: async ({ runtime, state }) => {
        if (state.revision === 1) {
          firstExecutionStarted.resolve();
          await allowFirstExecutionToFinish.promise;
        }
        return {
          runtimeRevision: runtime.revision,
          releasedDuringRun: runtime.released,
        };
      },
      release: ({ runtime }) => {
        releaseCalls += 1;
        runtime.released = true;
      },
    },
  ]);

  const session = new IgnitionSession({ registry, mode: "ignition" });
  const firstRun = session.run({ request: { kind: "use" }, state: { revision: 1 } });
  await firstExecutionStarted.promise;

  let assertionFailure = null;
  let firstResult;
  try {
    const second = await settle(session.run({ request: { kind: "use" }, state: { revision: 2 } }));
    assert.equal(second.status, "rejected", "overlapping stateful work must not enter the session concurrently");
    assert.equal(second.error?.code, "AXM_SESSION_OPERATION_BUSY");
    assert.equal(releaseCalls, 0, "the active runtime must not be released by a competing run");
    assert.equal(runtimes[0]?.released, false);
    assert.equal(runtimes.length, 1, "a refused competing run must not materialize another runtime");
  } catch (error) {
    assertionFailure = error;
  } finally {
    allowFirstExecutionToFinish.resolve();
    firstResult = await firstRun;
    await session.close();
  }

  if (assertionFailure) throw assertionFailure;
  assert.equal(firstResult.result.runtime.releasedDuringRun, false);
  assert.equal(firstResult.result.runtime.runtimeRevision, 1);
});

test("a concurrent cold run cannot duplicate materialization into one session cache", async () => {
  const firstMaterializationStarted = deferred();
  const allowFirstMaterializationToFinish = deferred();
  let materializeCalls = 0;
  let releaseCalls = 0;

  const registry = new CapabilityRegistry([
    {
      id: "runtime",
      match: (request) => request.kind === "use",
      materialize: async () => {
        materializeCalls += 1;
        const ordinal = materializeCalls;
        if (ordinal === 1) {
          firstMaterializationStarted.resolve();
          await allowFirstMaterializationToFinish.promise;
        }
        return { instance: { ordinal }, allocatedBytes: 16 };
      },
      run: ({ runtime }) => ({ ordinal: runtime.ordinal }),
      release: () => {
        releaseCalls += 1;
      },
    },
  ]);

  const session = new IgnitionSession({ registry, mode: "ignition" });
  const firstRun = session.run({ request: { kind: "use" }, state: { revision: 1 } });
  await firstMaterializationStarted.promise;

  let assertionFailure = null;
  let firstResult;
  try {
    const second = await settle(session.run({ request: { kind: "use" }, state: { revision: 1 } }));
    assert.equal(second.status, "rejected", "overlapping cold runs must not both materialize the same cache entry");
    assert.equal(second.error?.code, "AXM_SESSION_OPERATION_BUSY");
    assert.equal(materializeCalls, 1, "the competing run must be refused before materialization");
  } catch (error) {
    assertionFailure = error;
  } finally {
    allowFirstMaterializationToFinish.resolve();
    firstResult = await firstRun;
    await session.close();
  }

  if (assertionFailure) throw assertionFailure;
  assert.equal(firstResult.result.runtime.ordinal, 1);
  assert.equal(materializeCalls, 1);
  assert.equal(releaseCalls, 1, "the one admitted runtime should be released exactly once at close");
});
