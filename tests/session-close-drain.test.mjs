import test from "node:test";
import assert from "node:assert/strict";

import { CapabilityRegistry, hashValue } from "../src/ignition-core.js";
import { IgnitionSession } from "../src/ignition-session.js";
import { createTransitionReceipt } from "../src/scoped-invalidation.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("close waits for a pre-close materialization and then releases the admitted runtime", async () => {
  const materializeStarted = deferred();
  const allowMaterialize = deferred();
  let releaseCalls = 0;
  let closeSettled = false;

  const registry = new CapabilityRegistry([
    {
      id: "runtime",
      match: (request) => request.kind === "use",
      materialize: async () => {
        materializeStarted.resolve();
        await allowMaterialize.promise;
        return { instance: { live: true }, allocatedBytes: 32 };
      },
      run: ({ runtime }) => ({ live: runtime?.live === true }),
      release: () => { releaseCalls += 1; },
    },
  ]);
  const session = new IgnitionSession({ registry, mode: "ignition" });

  const runPromise = session.run({ request: { kind: "use" }, state: { revision: 1 } });
  await materializeStarted.promise;

  const closePromise = session.close({ state: { revision: 1 } }).then(() => { closeSettled = true; });
  await nextTurn();

  assert.equal(session.closed, true);
  assert.equal(closeSettled, false, "close must wait for work admitted before close");
  assert.equal(releaseCalls, 0);

  allowMaterialize.resolve();
  const run = await runPromise;
  assert.deepEqual(run.result.runtime, { live: true });
  await closePromise;

  assert.equal(releaseCalls, 1);
  assert.deepEqual(session.cachedCapabilityIds, []);
  assert.equal(session.stateHash, null);
});

test("close never releases a runtime while a pre-close capability execution is using it", async () => {
  const executionStarted = deferred();
  const allowExecution = deferred();
  const runtime = { released: false };
  let releaseCalls = 0;
  let closeSettled = false;

  const registry = new CapabilityRegistry([
    {
      id: "runtime",
      match: (request) => request.kind === "use",
      materialize: () => ({ instance: runtime, allocatedBytes: 32 }),
      run: async ({ runtime: activeRuntime }) => {
        executionStarted.resolve();
        await allowExecution.promise;
        assert.equal(activeRuntime.released, false, "active runtime was released before admitted execution settled");
        return { ok: true };
      },
      release: ({ runtime: activeRuntime }) => {
        releaseCalls += 1;
        activeRuntime.released = true;
      },
    },
  ]);
  const session = new IgnitionSession({ registry, mode: "ignition" });

  const runPromise = session.run({ request: { kind: "use" }, state: { revision: 1 } });
  await executionStarted.promise;

  const closePromise = session.close({ state: { revision: 1 } }).then(() => { closeSettled = true; });
  await nextTurn();

  assert.equal(session.closed, true);
  assert.equal(closeSettled, false, "close must remain pending while admitted execution is active");
  assert.equal(releaseCalls, 0, "terminal cleanup must not race an active capability run");

  allowExecution.resolve();
  await runPromise;
  await closePromise;

  assert.equal(releaseCalls, 1);
  assert.equal(runtime.released, true);
  assert.deepEqual(session.cachedCapabilityIds, []);
  assert.equal(session.stateHash, null);
});

test("close waits for an admitted transition instead of duplicating its release or restoring state afterward", async () => {
  const transitionReleaseStarted = deferred();
  const allowTransitionRelease = deferred();
  let releaseCalls = 0;
  let closeSettled = false;

  const registry = new CapabilityRegistry([
    {
      id: "runtime",
      match: (request) => request.kind === "use",
      materialize: () => ({ instance: { live: true }, allocatedBytes: 32 }),
      run: () => ({ ok: true }),
      release: async () => {
        releaseCalls += 1;
        transitionReleaseStarted.resolve();
        await allowTransitionRelease.promise;
      },
    },
  ]);
  const before = { revision: 1 };
  const after = { revision: 2 };
  const session = new IgnitionSession({
    registry,
    mode: "ignition",
    domainBindings: { runtime: ["content"] },
  });

  await session.run({ request: { kind: "use" }, state: before });
  const transitionReceipt = createTransitionReceipt({
    fromStateHash: hashValue(before),
    toStateHash: hashValue(after),
    changedDomains: ["content"],
  });

  const transitionPromise = session.applyTransition({ transitionReceipt, state: after });
  await transitionReleaseStarted.promise;

  const closePromise = session.close({ state: after }).then(() => { closeSettled = true; });
  await nextTurn();

  assert.equal(session.closed, true);
  assert.equal(closeSettled, false, "close must wait for a transition admitted before close");
  assert.equal(releaseCalls, 1, "close must not invoke a second release while transition cleanup owns the runtime");

  allowTransitionRelease.resolve();
  const applied = await transitionPromise;
  assert.equal(applied.resultingStateHash, transitionReceipt.toStateHash);
  await closePromise;

  assert.equal(releaseCalls, 1);
  assert.deepEqual(session.cachedCapabilityIds, []);
  assert.equal(session.stateHash, null, "terminal close must win after admitted transition settles");
});
