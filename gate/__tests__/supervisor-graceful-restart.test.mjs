import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { Supervisor } from '../core/service/supervisor.mjs';

// A `service restart` asks the child to close, and the child's clean exit then
// ran through the crash path: `_failures` grew and the respawn waited out the
// backoff (1 s, 2 s ... up to 60 s). Repeated deliberate restarts inside the
// ten-minute stable window therefore kept the Gate down for longer each time.
// These tests pin the deliberate-restart path against a fake clock, so the
// delay is observed rather than slept through.

let nextPid = 70000;

/** A fake Gate child: an EventEmitter with a pid and a recorded send. */
function fakeChild() {
  const child = new EventEmitter();
  child.pid = nextPid += 1;
  child.sent = [];
  child.send = (message) => {
    child.sent.push(message);
    return true;
  };
  return child;
}

/**
 * A supervisor on a fake clock: every `schedule` call is recorded, and only
 * the test decides when a timer fires. Nothing else runs on real time, so an
 * assertion about a backoff delay is exact.
 */
function harness(overrides = {}) {
  const children = [];
  const killed = [];
  const states = [];
  const timers = [];
  let nowMs = 1_000_000;
  const sup = new Supervisor({
    spawnGate: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    probe: async () => true,
    killTree: (pid) => {
      killed.push(pid);
      children.find((child) => child.pid === pid)?.emit('exit', null, 'SIGKILL');
    },
    schedule: (fn, ms) => {
      const timer = { ms, fn, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      timer.cancelled = true;
    },
    now: () => nowMs,
    writeState: (state) => states.push(state),
    log: () => {},
    backoffMs: [7000, 15000, 40000],
    graceMs: 90000,
    probeIntervalMs: 30000,
    stableMs: 600000,
    stopKillMs: 10000,
    ...overrides,
  });
  const pending = (ms) => timers.filter((timer) => !timer.cancelled && timer.ms === ms);
  return {
    sup,
    children,
    killed,
    states,
    pending,
    /** Fire every live timer with this delay, as the real scheduler would. */
    flush(ms) {
      const due = pending(ms);
      for (const timer of due) {
        timer.cancelled = true;
        timer.fn();
      }
      return due.length;
    },
    advance: (ms) => { nowMs += ms; },
  };
}

test('a requested restart respawns at once instead of waiting out the crash backoff', () => {
  const h = harness();
  h.sup.start();
  assert.equal(h.children.length, 1);
  const first = h.children[0];

  h.sup.requestRestart();
  assert.deepEqual(first.sent, [{ type: 'shutdown' }], 'the child is asked to close gracefully');
  assert.equal(h.states.at(-1).status, 'restarting');

  // The well-behaved child honours the shutdown and exits cleanly.
  first.emit('exit', 0, null);

  assert.equal(h.pending(7000).length, 0, 'a deliberate restart never enters the crash ladder');
  assert.equal(h.states.at(-1).status, 'restarting', 'the state says the Gate is coming back');
  assert.equal(h.flush(0), 1, 'the respawn is queued for the next tick, not for a backoff');
  assert.equal(h.children.length, 2, 'the Gate is back');
  assert.equal(h.states.at(-1).status, 'running');
  assert.equal(h.states.at(-1).childPid, h.children[1].pid);

  // The crash ladder was untouched: the next genuine crash earns step one.
  h.children[1].emit('exit', 1, null);
  assert.equal(h.pending(7000).length, 1, 'a real crash still waits the first backoff');
  assert.equal(h.flush(7000), 1);
  assert.equal(h.children.length, 3, 'and then the Gate is restarted');
});

test('a deliberate restart between crashes does not step the backoff ladder up', () => {
  const h = harness();
  h.sup.start();

  // Crash one: the first backoff step.
  h.children[0].emit('exit', 1, null);
  assert.equal(h.pending(7000).length, 1);
  assert.equal(h.flush(7000), 1);
  assert.equal(h.children.length, 2);

  // A restart in between must not count as a second failure.
  h.sup.requestRestart();
  h.children[1].emit('exit', 0, null);
  assert.equal(h.pending(15000).length, 0, 'the requested restart is not booked as a crash');
  assert.equal(h.flush(0), 1);
  assert.equal(h.children.length, 3);

  // The next real crash is still only the second failure: step two, not three.
  h.children[2].emit('exit', 1, null);
  assert.equal(h.pending(15000).length, 1, 'failures stayed at one across the deliberate restart');
  assert.equal(h.pending(40000).length, 0);
});

test('a requested restart that times out is tree-killed and still comes back at once', () => {
  const h = harness();
  h.sup.start();
  const first = h.children[0];

  h.sup.requestRestart();
  // The child ignores the shutdown message: the stopKillMs watchdog ends it.
  assert.equal(h.flush(10000), 1, 'the restart watchdog is armed');
  assert.deepEqual(h.killed, [first.pid], 'the deaf child was tree-killed');
  assert.equal(h.pending(7000).length, 0, 'a forced deliberate restart is not a crash either');
  assert.equal(h.flush(0), 1);
  assert.equal(h.children.length, 2);
});

test('stopping while the requested respawn is queued leaves the Gate stopped', async () => {
  const h = harness();
  h.sup.start();
  h.sup.requestRestart();
  h.children[0].emit('exit', 0, null);
  assert.equal(h.pending(0).length, 1, 'the respawn is waiting for the next tick');

  await h.sup.stop();

  assert.equal(h.children.length, 1, 'no child was spawned during the stop');
  assert.equal(h.flush(0), 0, 'stop cancelled the queued respawn');
  assert.equal(h.children.length, 1, 'stopped means stopped');
  assert.equal(h.states.at(-1).status, 'stopped');
  assert.equal(h.states.at(-1).childPid, null);
});
