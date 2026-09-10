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

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeSession(release) {
  const registry = new CapabilityRegistry([
    {
      id: "runtime",
      match: (request) => request.kind === "use",
      materialize: () => ({ instance: { live: true }, allocatedBytes: 32 }),
      run: ({ runtime }) => ({ live: runtime?.live === true }),
      release,
    },
  ]);
  return new IgnitionSession({ registry, mode: "ignition" });
}

test("concurrent external close callers await the same successful terminal cleanup", async () => {
  const releaseStarted = deferred();
  const allowRelease = deferred();
  let releaseCalls = 0;
  let firstSettled = false;
  let secondSettled = false;

  const session = makeSession(async () => {
    releaseCalls += 1;
    releaseStarted.resolve();
    await allowRelease.promise;
  });

  await session.run({ request: { kind: "use" }, state: { revision: 1 } });

  const firstClose = session.close({ state: { revision: 1 } }).then(() => { firstSettled = true; });
  await releaseStarted.promise;

  const secondClose = session.close({ state: { revision: 1 } }).then(() => { secondSettled = true; });
  await nextTurn();

  assert.equal(session.closed, true);
  assert.equal(firstSettled, false, "first close must remain pending while terminal cleanup is blocked");
  assert.equal(secondSettled, false, "a concurrent close must not report completion before terminal cleanup finishes");
  assert.equal(releaseCalls, 1, "concurrent close callers must not duplicate terminal cleanup");

  allowRelease.resolve();
  await Promise.all([firstClose, secondClose]);

  assert.equal(firstSettled, true);
  assert.equal(secondSettled, true);
  assert.equal(releaseCalls, 1);
  assert.deepEqual(session.cachedCapabilityIds, []);
  assert.equal(session.stateHash, null);
});

test("concurrent external close callers observe the same cleanup failure", async () => {
  const releaseStarted = deferred();
  const allowFailure = deferred();
  let releaseCalls = 0;
  let secondSettled = false;

  const session = makeSession(async () => {
    releaseCalls += 1;
    releaseStarted.resolve();
    await allowFailure.promise;
    throw new Error("synthetic concurrent close cleanup failure");
  });

  await session.run({ request: { kind: "use" }, state: { revision: 2 } });

  const firstClose = session.close({ state: { revision: 2 } });
  await releaseStarted.promise;

  const secondClose = session.close({ state: { revision: 2 } }).then(
    () => {
      secondSettled = true;
      return { status: "fulfilled" };
    },
    (error) => {
      secondSettled = true;
      return { status: "rejected", error };
    },
  );

  await nextTurn();
  assert.equal(secondSettled, false, "a concurrent close must not hide an in-flight cleanup failure by returning early");
  assert.equal(releaseCalls, 1);

  allowFailure.resolve();
  const [first, second] = await Promise.all([
    firstClose.then(
      () => ({ status: "fulfilled" }),
      (error) => ({ status: "rejected", error }),
    ),
    secondClose,
  ]);

  assert.equal(first.status, "rejected");
  assert.equal(second.status, "rejected");
  assert.equal(first.error?.code, "AXM_SESSION_RELEASE_FAILED");
  assert.equal(second.error?.code, "AXM_SESSION_RELEASE_FAILED");
  assert.deepEqual(first.error?.failedCapabilityIds, ["runtime"]);
  assert.deepEqual(second.error?.failedCapabilityIds, ["runtime"]);
  assert.equal(first.error, second.error, "concurrent close callers should observe one terminal cleanup failure instance");
  assert.equal(releaseCalls, 1);
  assert.deepEqual(session.cachedCapabilityIds, []);
  assert.equal(session.stateHash, null);

  // Preserve the established terminal/idempotent contract after the failed close has settled.
  await session.close({ state: { revision: 2 } });
  assert.equal(releaseCalls, 1);
});
