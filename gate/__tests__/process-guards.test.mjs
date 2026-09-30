import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { installProcessGuards } from '../core/process-guards.mjs';

/** A fake process: the guards only ever touch these two events. */
function harness() {
  const proc = new EventEmitter();
  const logged = [];
  const exits = [];
  const uninstall = installProcessGuards({
    proc,
    log: (line) => logged.push(line),
    exit: (code) => exits.push(code),
  });
  return { proc, logged, exits, uninstall };
}

function errorWithCode(code) {
  return Object.assign(new Error(`write failed: ${code}`), { code });
}

test('a broken pipe is survived — the peer went away, not this process', () => {
  // A write to a dying child is the case that used to exit the Gate and drop
  // every phone stream, call and terminal it was serving.
  const { proc, logged, exits, uninstall } = harness();
  try {
    for (const code of ['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']) {
      proc.emit('uncaughtException', errorWithCode(code));
    }

    assert.deepEqual(exits, [], 'a dead peer must not take the Gate down');
    assert.deepEqual(logged.map((line) => line.match(/surviv\w+ (\w+)/)?.[1]), [
      'EPIPE',
      'ECONNRESET',
      'ERR_STREAM_DESTROYED',
      'ERR_STREAM_WRITE_AFTER_END',
    ]);
  } finally {
    uninstall();
  }
});

test('an unrecognised exception exits so the supervisor can restart a clean process', () => {
  const { proc, logged, exits, uninstall } = harness();
  try {
    proc.emit('uncaughtException', new TypeError('sessions is not a function'));

    assert.deepEqual(exits, [1]);
    assert.ok(
      logged.some((line) => line.includes('sessions is not a function')),
      'the message has to be in the log to be findable after a restart',
    );
    assert.ok(
      logged.some((line) => /\n\s+at /.test(line)),
      'the stack belongs in the log too',
    );
  } finally {
    uninstall();
  }
});

test('an isolated rejection is logged and survived', () => {
  const { proc, logged, exits, uninstall } = harness();
  try {
    proc.emit('unhandledRejection', new Error('socket hang up'));
    proc.emit('unhandledRejection', 'a bare string reason');

    assert.deepEqual(exits, []);
    assert.ok(logged.some((line) => line.includes('socket hang up')));
    assert.ok(logged.some((line) => line.includes('a bare string reason')));
  } finally {
    uninstall();
  }
});

test('a rejection storm exits: restarting into a bug loop would just spin', () => {
  const { proc, logged, exits, uninstall } = harness();
  try {
    for (let i = 0; i < 20; i += 1) proc.emit('unhandledRejection', new Error(`boom ${i}`));
    assert.deepEqual(exits, [], 'twenty rejections is a bad minute, not a loop');

    proc.emit('unhandledRejection', new Error('boom 21'));
    assert.deepEqual(exits, [1]);
    assert.ok(
      logged.some((line) => /21 unhandled rejections in 60s/.test(line)),
      'the exit must say what was wrong, not just happen',
    );
  } finally {
    uninstall();
  }
});

test('installing twice registers one handler, and uninstall takes it away', () => {
  const proc = new EventEmitter();
  const exits = [];
  const first = installProcessGuards({ proc, log: () => {}, exit: (code) => exits.push(code) });
  const second = installProcessGuards({ proc, log: () => {}, exit: (code) => exits.push(code) });

  assert.equal(proc.listenerCount('uncaughtException'), 1);
  assert.equal(proc.listenerCount('unhandledRejection'), 1);
  proc.emit('uncaughtException', new Error('boom'));
  assert.deepEqual(exits, [1], 'one handler means one exit, not one per install');

  second();
  first();
  assert.equal(proc.listenerCount('uncaughtException'), 0);
  assert.equal(proc.listenerCount('unhandledRejection'), 0);

  // A fresh install after an uninstall is a fresh window, not a stuck one.
  const exits2 = [];
  const again = installProcessGuards({ proc, log: () => {}, exit: (code) => exits2.push(code) });
  proc.emit('uncaughtException', new Error('boom again'));
  assert.deepEqual(exits2, [1]);
  again();
});
