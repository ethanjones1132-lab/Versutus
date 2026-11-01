// Pin for the provider-runtime smoke cleanup (../smoke-provider-runtime.mjs).
//
// The smoke used to close each Gate immediately after the check that used it,
// so an assertion failing between `createGate` and those `await gate.close()`
// lines left a listening Gate behind. The run then hung on the open socket
// instead of exiting red, and the failure looked like a timeout. The runner
// now tracks every Gate it starts and releases the remainder on the way out.
//
// These tests drive the runner with injected `createGateImpl` / `request`
// dependencies. The provider is the script's own loopback fixture, so no real
// provider, account or network service is contacted.
//
// Lives under scripts/__tests__ (not gate/__tests__) because it pins a repo
// script; it runs through the same `npm run test:gate` node --test leg.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGate } from '../../gate/core/server.mjs';
import { runProviderSmoke } from '../smoke-provider-runtime.mjs';

/**
 * Wrap a Gate factory so the test can see which Gates were started and which
 * were closed. The original `close` is kept out of band: cleanup for a leak
 * must not count as the runner having closed the Gate.
 */
function trackGates() {
  const opened = [];
  const closed = [];
  const originals = new WeakMap();
  const createGateImpl = async (config) => {
    const gate = await createGate(config);
    const close = gate.close.bind(gate);
    originals.set(gate, close);
    opened.push(gate);
    gate.close = async () => {
      closed.push(gate);
      await close();
    };
    return gate;
  };
  return { opened, closed, originals, createGateImpl };
}

/**
 * `fetch` with an injected failure on the Nth call. Earlier calls reach the
 * real loopback Gate, so the failure happens at a realistic point in the run.
 */
function requestFailingOn(call) {
  let calls = 0;
  return (url, init) => {
    calls += 1;
    if (calls === call) throw new Error(`injected failure on providers request ${calls}`);
    return fetch(url, init);
  };
}

async function runTracked({ request, log = () => {} }) {
  const tracking = trackGates();
  const result = { ...tracking, error: null, logs: [] };
  try {
    await runProviderSmoke({
      createGateImpl: tracking.createGateImpl,
      request,
      log: (line) => {
        result.logs.push(line);
        log(line);
      },
    });
  } catch (error) {
    result.error = error;
  } finally {
    // A leaked Gate still owns a listening socket. Release it through the
    // original close so the test process can exit and the assertion below can
    // report the leak instead of hanging.
    for (const gate of tracking.opened) {
      if (tracking.closed.includes(gate)) continue;
      try {
        await tracking.originals.get(gate)();
      } catch {
        // already gone
      }
    }
  }
  return result;
}

test('closes the first Gate when the first providers check fails', async () => {
  const result = await runTracked({ request: requestFailingOn(1) });

  assert.ok(result.error, 'the injected failure should reject the smoke run');
  assert.match(result.error.message, /providers request 1/);
  assert.equal(result.opened.length, 1, 'one Gate should have been started');
  assert.deepEqual(result.closed, result.opened, 'the started Gate must be closed');
});

test('closes both Gates when the post-restart providers check fails', async () => {
  const result = await runTracked({ request: requestFailingOn(2) });

  assert.ok(result.error, 'the injected failure should reject the smoke run');
  assert.match(result.error.message, /providers request 2/);
  assert.equal(result.opened.length, 2, 'both Gates should have been started');
  assert.deepEqual(result.closed, result.opened, 'both started Gates must be closed');
});

test('the success path still passes and leaves nothing listening', async () => {
  const result = await runTracked({ request: fetch });

  assert.equal(result.error, null);
  assert.deepEqual(result.logs, ['smoke-provider-runtime: PASS']);
  assert.equal(result.opened.length, 2);
  assert.deepEqual(result.closed, result.opened);

  for (const gate of result.opened) {
    await assert.rejects(
      fetch(`http://127.0.0.1:${gate.port}/v1/providers`, {
        signal: AbortSignal.timeout(5_000),
      }),
      undefined,
      'a closed Gate must not answer its port',
    );
  }
});
