import test from "node:test";
import assert from "node:assert/strict";

import { CapabilityRegistry, hashValue } from "../src/ignition-core.js";
import { IgnitionSession } from "../src/ignition-session.js";

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

test("close revokes execution authority before asynchronous cleanup finishes", async () => {
  let releaseStartedResolve;
  let releaseContinueResolve;
  const releaseStarted = new Promise((resolve) => { releaseStartedResolve = resolve; });
  const releaseContinue = new Promise((resolve) => { releaseContinueResolve = resolve; });

  const session = makeSession(async () => {
    releaseStartedResolve();
    await releaseContinue;
  });

  await session.run({ request: { kind: "use" }, state: { revision: 1 } });
  assert.equal(session.closed, false);
  assert.deepEqual(session.cachedCapabilityIds, ["runtime"]);

  const closePromise = session.close({ state: { revision: 1 } });
  await releaseStarted;

  assert.equal(session.closed, true);
  await assert.rejects(
    session.run({ request: { kind: "use" }, state: { revision: 1 } }),
    /IgnitionSession is closed/,
  );
  await assert.rejects(
    session.applyTransition({ transitionReceipt: {} }),
    /IgnitionSession is closed/,
  );

  releaseContinueResolve();
  await closePromise;

  assert.equal(session.stateHash, null);
  assert.deepEqual(session.cachedCapabilityIds, []);
});

test("failed close remains terminal and clears canonical-session identity", async () => {
  let releaseCalls = 0;
  const state = { revision: 7 };
  const session = makeSession(() => {
    releaseCalls += 1;
    throw new Error("synthetic close cleanup failure");
  });

  await session.run({ request: { kind: "use" }, state });
  assert.equal(session.stateHash, hashValue(state));

  await assert.rejects(
    session.close({ state }),
    (error) => {
      assert.equal(error.code, "AXM_SESSION_RELEASE_FAILED");
      assert.deepEqual(error.failedCapabilityIds, ["runtime"]);
      assert.deepEqual(error.evictedCapabilityIds, ["runtime"]);
      return true;
    },
  );

  assert.equal(session.closed, true);
  assert.equal(session.stateHash, null);
  assert.deepEqual(session.cachedCapabilityIds, []);
  assert.equal(releaseCalls, 1);

  await assert.rejects(
    session.run({ request: { kind: "use" }, state }),
    /IgnitionSession is closed/,
  );
  await assert.rejects(
    session.applyTransition({ transitionReceipt: {} }),
    /IgnitionSession is closed/,
  );

  await session.close({ state });
  assert.equal(releaseCalls, 1);
});
