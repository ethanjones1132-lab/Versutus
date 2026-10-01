import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';
import { createEventLog } from '../core/cli-environments/run-protocol.mjs';
import { CliEnvironmentService } from '../core/cli-environments/supervisor.mjs';

// A run parked on an approval emits nothing at all, so a viewer that navigated
// away was still subscribed for as long as the run waited for a decision —
// indefinitely. These tests watch the REAL event log, because the mechanism
// that used to be used there (`return()` on the stream) provably does nothing
// against it: the generator re-parks at a fresh await every pass, so a return
// queued behind an in-flight `next()` is never honoured and the waiter stays in
// the log until the run happens to emit again.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const until = async (predicate, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(5);
  }
  return false;
};

const STARTED = {
  runId: 'run_parked', sequence: 1, type: 'run.started',
  timestamp: '2026-01-01T00:00:00.000Z', payload: {},
};
const COMPLETED = { ...STARTED, sequence: 2, type: 'run.completed', payload: { exitCode: 0 } };

/**
 * The real generator, with a witness on it.
 *
 * `seen.finished` only moves when the actual generator body runs to its end, so
 * it can distinguish a release from "the route stopped asking" — which is all a
 * spy on `return()` could ever have shown.
 */
function realEventLog(seen, { events } = {}) {
  const log = createEventLog('run_parked', events ? { events } : undefined);
  seen.log = log;
  return {
    stream(signal) {
      const inner = log.stream(signal);
      return {
        [Symbol.asyncIterator]() {
          const iterator = inner[Symbol.asyncIterator]();
          return {
            async next() {
              const result = await iterator.next();
              if (result.done) seen.finished += 1;
              return result;
            },
          };
        },
      };
    },
  };
}

async function stubEvents(t, seen, options = {}) {
  // The Gate builds its own supervisor, so the seam is the prototype.
  t.mock.method(CliEnvironmentService.prototype, 'events', function stubbed(runId, { signal } = {}) {
    seen.requested = runId;
    seen.signals = (seen.signals ?? 0) + 1;
    assert.ok(signal, 'the route must hand the stream a signal to unsubscribe with');
    return realEventLog(seen, options).stream(signal);
  });
  const root = await mkdtemp(join(tmpdir(), 'gate-env-events-release-'));
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  const gate = await createGate({ root, port: 0, gateHome: join(root, '.gate-home') });
  return { gate, root };
}

const cleanup = async (gate, root) => {
  await gate.close();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
};

const watchRun = (gate, { signal } = {}) => fetch(
  `http://127.0.0.1:${gate.port}/v1/environments/codex-local/runs/run_parked/events`,
  { headers: { Authorization: `Bearer ${gate.token}` }, ...(signal ? { signal } : {}) },
);

test('the event log drops the waiter of a subscriber that lets go', async () => {
  const log = createEventLog('run_parked');
  const controller = new AbortController();
  const stream = log.stream(controller.signal);
  // Nothing is logged yet, so this parks — the state a run waiting on an
  // approval holds every subscriber in.
  const parked = stream.next();
  await wait(0);
  assert.equal(log.pendingWaiters(), 1, 'a live subscriber is parked in the log');

  controller.abort();
  const result = await parked;
  assert.equal(result.done, true, 'an aborted subscriber ends instead of waiting for the next event');
  assert.equal(log.pendingWaiters(), 0, 'a released subscriber must not stay parked');

  // And the log keeps working for the run: the next emit reaches whoever is
  // still reading, and nobody is left behind to hold the run open.
  const survivor = createEventLog('run_parked');
  const kept = survivor.stream();
  const seenNext = kept.next();
  survivor.emit({ type: 'run.output', payload: {} });
  const event = await seenNext;
  assert.equal(event.value.type, 'run.output');
  log.emit({ type: 'run.output', payload: {} });
  assert.equal(log.pendingWaiters(), 0, 'a released stream is not woken by later events');
});

test('a viewer that leaves releases the run event subscription', async (t) => {
  const seen = { requested: null, finished: 0 };
  const { gate, root } = await stubEvents(t, seen, { events: [STARTED] });
  const controller = new AbortController();
  try {
    const response = await watchRun(gate, { signal: controller.signal });
    assert.equal(response.status, 200);
    // The streamed event proves the subscription was really opened before the
    // socket is torn down, so a release cannot be confused with never having
    // subscribed at all.
    const first = await response.body.getReader().read();
    assert.match(Buffer.from(first.value).toString(), /run\.started/);
    assert.equal(seen.requested, 'run_parked');
    assert.ok(
      await until(() => seen.log.pendingWaiters() === 1),
      'a live viewer holds exactly one subscription',
    );
    assert.equal(seen.finished, 0);

    controller.abort();
    assert.ok(
      await until(() => seen.log.pendingWaiters() === 0),
      'a client that walked away must release the subscription, not hold it to the end of the run',
    );
    assert.equal(
      await until(() => seen.finished > 0),
      true,
      'the real event-log generator must run to its end, not merely be abandoned mid-await',
    );
  } finally {
    await cleanup(gate, root);
  }
});

test('a run that reaches its terminal event still ends the response cleanly', async (t) => {
  const seen = { requested: null, finished: 0 };
  const { gate, root } = await stubEvents(t, seen, { events: [STARTED, COMPLETED] });
  try {
    const text = await (await watchRun(gate)).text();
    // The happy path must be untouched by the release: every event, then the
    // end of the response, with no `run.failed` invented out of the break.
    assert.match(text, /run\.started/);
    assert.match(text, /run\.completed/);
    assert.doesNotMatch(text, /run\.failed/);
    assert.equal(seen.log.pendingWaiters(), 0, 'a finished run holds no subscription');
    assert.equal(seen.finished, 1, 'the stream ends on its own at the terminal event');
  } finally {
    await cleanup(gate, root);
  }
});

test('a run whose stream fails reports the failure on the wire', async (t) => {
  // A log cannot fail mid-stream the way a broken archive can, so this one keeps
  // a throwing iterator: the contract under test is the route's error frame.
  t.mock.method(CliEnvironmentService.prototype, 'events', function stubbed() {
    return {
      [Symbol.asyncIterator]() {
        return { async next() { throw new Error('the run log is gone'); } };
      },
    };
  });
  const root = await mkdtemp(join(tmpdir(), 'gate-env-events-release-'));
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  const gate = await createGate({ root, port: 0, gateHome: join(root, '.gate-home') });
  try {
    const text = await (await watchRun(gate)).text();
    assert.match(text, /"type":"run\.failed"/);
    assert.match(text, /the run log is gone/);
  } finally {
    await cleanup(gate, root);
  }
});
