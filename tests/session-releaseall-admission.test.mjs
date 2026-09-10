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

test("external releaseAll cannot release a runtime while admitted work is using it", async () => {
  const executionStarted = deferred();
  const allowExecutionToFinish = deferred();
  let releaseCalls = 0;
  const runtime = { released: false };

  const registry = new CapabilityRegistry([
    {
      id: "runtime",
      match: (request) => request.kind === "use",
      materialize: () => ({ instance: runtime, allocatedBytes: 16 }),
      run: async ({ runtime: activeRuntime }) => {
        executionStarted.resolve();
        await allowExecutionToFinish.promise;
        return { releasedDuringRun: activeRuntime.released };
      },
      release: ({ runtime: activeRuntime }) => {
        releaseCalls += 1;
        activeRuntime.released = true;
      },
    },
  ]);

  const session = new IgnitionSession({ registry, mode: "ignition" });
  const running = session.run({ request: { kind: "use" }, state: { revision: 1 } });
  await executionStarted.promise;

  let assertionFailure = null;
  let result;
  try {
    const release = await settle(session.releaseAll());
    assert.equal(release.status, "rejected", "manual cleanup must not cross an active operation boundary");
    assert.equal(release.error?.code, "AXM_SESSION_RELEASE_BUSY");
    assert.equal(releaseCalls, 0);
    assert.equal(runtime.released, false);
  } catch (error) {
    assertionFailure = error;
  } finally {
    allowExecutionToFinish.resolve();
    result = await running;
    await session.close();
  }

  if (assertionFailure) throw assertionFailure;
  assert.equal(result.result.runtime.releasedDuringRun, false);
  assert.equal(releaseCalls, 1, "terminal cleanup should release the runtime exactly once after work settles");
});

test("a stateful run cannot enter while external releaseAll cleanup is in flight", async () => {
  const releaseStarted = deferred();
  const allowReleaseToFinish = deferred();
  let releaseCalls = 0;
  let runCalls = 0;

  const registry = new CapabilityRegistry([
    {
      id: "runtime",
      match: (request) => request.kind === "use",
      materialize: () => ({ instance: {}, allocatedBytes: 8 }),
      run: () => {
        runCalls += 1;
        return { runCalls };
      },
      release: async () => {
        releaseCalls += 1;
        releaseStarted.resolve();
        await allowReleaseToFinish.promise;
      },
    },
  ]);

  const session = new IgnitionSession({ registry, mode: "ignition" });
  await session.run({ request: { kind: "use" }, state: { revision: 1 } });
  assert.equal(runCalls, 1);

  const releasing = session.releaseAll();
  await releaseStarted.promise;

  let assertionFailure = null;
  try {
    const competingRun = await settle(session.run({ request: { kind: "use" }, state: { revision: 1 } }));
    assert.equal(competingRun.status, "rejected", "stateful work must not enter a cache being manually released");
    assert.equal(competingRun.error?.code, "AXM_SESSION_RELEASE_BUSY");
    assert.equal(runCalls, 1, "the refused run must not execute capability code");
  } catch (error) {
    assertionFailure = error;
  } finally {
    allowReleaseToFinish.resolve();
    await releasing;
    await session.close();
  }

  if (assertionFailure) throw assertionFailure;
  assert.equal(releaseCalls, 1);
});

test("capability work cannot re-enter public releaseAll and tear down its own runtime", async () => {
  let session;
  let releaseCalls = 0;
  const runtime = { released: false };

  const registry = new CapabilityRegistry([
    {
      id: "runtime",
      match: (request) => request.kind === "use",
      materialize: () => ({ instance: runtime, allocatedBytes: 12 }),
      run: async ({ runtime: activeRuntime }) => {
        const release = await settle(session.releaseAll());
        return {
          releaseStatus: release.status,
          releaseCode: release.error?.code ?? null,
          releasedDuringRun: activeRuntime.released,
        };
      },
      release: ({ runtime: activeRuntime }) => {
        releaseCalls += 1;
        activeRuntime.released = true;
      },
    },
  ]);

  session = new IgnitionSession({ registry, mode: "ignition" });
  const result = await session.run({ request: { kind: "use" }, state: { revision: 1 } });

  assert.equal(result.result.runtime.releaseStatus, "rejected");
  assert.equal(result.result.runtime.releaseCode, "AXM_SESSION_RELEASE_BUSY");
  assert.equal(result.result.runtime.releasedDuringRun, false);
  assert.equal(releaseCalls, 0, "re-entrant cleanup must not release the runtime during capability execution");

  await session.close();
  assert.equal(releaseCalls, 1);
});
