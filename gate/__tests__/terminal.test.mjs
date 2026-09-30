import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createTerminalSessions } from '../core/cli-environments/terminal.mjs';

/** A child_process stand-in: no real shell, but the same event surface. */
let nextPid = 4242;

function fakeChild() {
  const child = new EventEmitter();
  child.pid = nextPid++;
  child.exitCode = null;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter();
  stdin.writable = true;
  stdin.written = [];
  stdin.write = (data) => { stdin.written.push(data); return true; };
  child.stdin = stdin;
  child.kill = () => { child.killed = true; child.exitCode = 0; };
  return child;
}

/**
 * A shell that exits after the write is accepted: the pipe reports EPIPE on
 * the next tick, with `exitCode` still null, exactly as a closed pipe does.
 */
function breakStdinOnNextWrite(child) {
  const { stdin } = child;
  const write = stdin.write.bind(stdin);
  stdin.write = (data) => {
    const ok = write(data);
    queueMicrotask(() => {
      stdin.writable = false;
      stdin.destroyed = true;
      stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    });
    return ok;
  };
  return child;
}

function harness({ maxSessions } = {}) {
  const spawned = [];
  const spawnImpl = (command, args) => {
    const child = fakeChild();
    spawned.push({ command, args, child });
    return child;
  };
  const sessions = createTerminalSessions({
    spawnImpl,
    shell: () => ({ command: 'fake-sh', args: [] }),
    ...(maxSessions ? { maxSessions } : {}),
  });
  const shells = () => spawned.filter((entry) => entry.command === 'fake-sh');
  /**
   * A shell is dead if its child was killed directly or a taskkill was issued
   * for its pid — win32 takes the second path, every other platform the first.
   */
  const isDead = (entry) =>
    entry.child.killed || spawned.some((s) => s.command === 'taskkill' && s.args.includes(String(entry.child.pid)));
  return { sessions, spawned, shells, isDead };
}

test('opening a session spawns a shell and hands back a routable id', () => {
  const { sessions, spawned } = harness();
  const session = sessions.open({ onChunk() {}, onExit() {} });

  assert.equal(spawned[0].command, 'fake-sh');
  assert.ok(session.sid, 'a session id is required to route input');
  assert.equal(sessions.get(session.sid), session);
  assert.equal(sessions.size, 1);
});

test('stdout and stderr both reach the client as one stream', () => {
  const { sessions, spawned } = harness();
  const chunks = [];
  sessions.open({ onChunk: (text) => chunks.push(text), onExit() {} });

  spawned[0].child.stdout.emit('data', Buffer.from('out\n', 'utf8'));
  spawned[0].child.stderr.emit('data', Buffer.from('err\n', 'utf8'));

  // The app renders one line list; splitting the streams would lose ordering.
  assert.deepEqual(chunks, ['out\n', 'err\n']);
});

test('input is written to the shell verbatim', () => {
  const { sessions, spawned } = harness();
  const session = sessions.open({ onChunk() {}, onExit() {} });

  // The app appends its own newline, so the Gate must not add another.
  session.write('echo hi\n');
  assert.deepEqual(spawned[0].child.stdin.written, ['echo hi\n']);
});

test('an exiting shell reports its code and stops being routable', () => {
  const { sessions, spawned } = harness();
  const exits = [];
  const session = sessions.open({ onChunk() {}, onExit: (code) => exits.push(code) });

  spawned[0].child.exitCode = 3;
  spawned[0].child.emit('exit', 3);

  assert.deepEqual(exits, [3]);
  assert.equal(sessions.get(session.sid), null, 'a dead session must not accept input');
  assert.equal(sessions.size, 0);
});

test('a spawn failure surfaces as an error rather than a silent dead stream', () => {
  const { sessions, spawned } = harness();
  const errors = [];
  sessions.open({ onChunk() {}, onExit() {}, onError: (message) => errors.push(message) });

  spawned[0].child.emit('error', new Error('ENOENT: no shell'));
  assert.deepEqual(errors, ['ENOENT: no shell']);
  assert.equal(sessions.size, 0);
});

test('closing a session kills the shell — a dropped phone must not leak one', () => {
  const { sessions, shells, isDead } = harness();
  const session = sessions.open({ onChunk() {}, onExit() {} });

  session.close();
  assert.equal(sessions.get(session.sid), null);
  assert.ok(isDead(shells()[0]), 'the shell process tree must be torn down');
});

test('writing to an exited session fails loudly', () => {
  const { sessions, spawned } = harness();
  const session = sessions.open({ onChunk() {}, onExit() {} });
  spawned[0].child.exitCode = 0;

  assert.throws(() => session.write('ls\n'), /has exited/);
});

test('a keystroke into a shell that just died ends the session, not the Gate', async () => {
  // The shell exits between one POST and the next: its stdin raises EPIPE with
  // no 'exit' event delivered. With no 'error' listener that uncaught
  // exception killed the Gate and every other session with it.
  const { sessions, spawned } = harness();
  const errors = [];
  const session = sessions.open({ onChunk() {}, onExit() {}, onError: (m) => errors.push(m) });
  breakStdinOnNextWrite(spawned[0].child);

  session.write('ls\n');
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(errors, ['write EPIPE'], 'the failure belongs to the session');
  assert.equal(sessions.get(session.sid), null);
  assert.equal(sessions.size, 0);
  assert.throws(() => session.write('pwd\n'), /terminal session has exited/);
});

test('a dead pipe reports once, even when the exit it caused follows', async () => {
  const { sessions, spawned } = harness();
  const errors = [];
  const exits = [];
  sessions.open({ onChunk() {}, onExit: (c) => exits.push(c), onError: (m) => errors.push(m) });
  breakStdinOnNextWrite(spawned[0].child);

  spawned[0].child.stdin.write('ls\n');
  await new Promise((resolve) => setTimeout(resolve, 10));
  spawned[0].child.exitCode = 0;
  spawned[0].child.emit('exit', 0);

  assert.deepEqual(errors, ['write EPIPE'], 'one session reports one failure');
  assert.deepEqual(exits, [0]);
  assert.equal(sessions.size, 0);
});

test('session count is bounded so one client cannot exhaust the host', () => {
  const { sessions } = harness({ maxSessions: 2 });
  sessions.open({ onChunk() {}, onExit() {} });
  sessions.open({ onChunk() {}, onExit() {} });

  assert.throws(() => sessions.open({ onChunk() {}, onExit() {} }), /too many terminal sessions/);
});

test('closeAll tears down every live shell', () => {
  const { sessions, shells, isDead } = harness();
  sessions.open({ onChunk() {}, onExit() {} });
  sessions.open({ onChunk() {}, onExit() {} });

  sessions.closeAll();
  assert.equal(sessions.size, 0);
  assert.equal(shells().length, 2);
  for (const shell of shells()) assert.ok(isDead(shell), `pid ${shell.child.pid} outlived closeAll`);
});

test('a large burst is split across frames, not truncated', () => {
  // `subarray(0, MAX)` dropped everything past the cap. A command that prints a
  // lot in one go lost its tail with nothing to indicate it.
  const { sessions, spawned } = harness();
  const chunks = [];
  sessions.open({ onChunk: (t) => chunks.push(t), onExit() {} });

  const payload = 'x'.repeat(200_000);
  spawned[0].child.stdout.emit('data', Buffer.from(payload, 'utf8'));

  assert.ok(chunks.length > 1, 'a 200k burst should span several frames');
  assert.equal(chunks.join(''), payload, 'no output may be lost');
});

test('a multi-byte character split across two reads survives', () => {
  // 'é' is two bytes; delivering them in separate 'data' events used to decode
  // each half independently and produce replacement characters.
  const { sessions, spawned } = harness();
  const chunks = [];
  sessions.open({ onChunk: (t) => chunks.push(t), onExit() {} });

  const bytes = Buffer.from('café', 'utf8');
  spawned[0].child.stdout.emit('data', bytes.subarray(0, 4));
  spawned[0].child.stdout.emit('data', bytes.subarray(4));

  assert.equal(chunks.join(''), 'café');
  assert.ok(!chunks.join('').includes('�'), 'no replacement characters');
});

test('stdout and stderr decode independently', () => {
  // Sharing one decoder would let a partial sequence on one stream corrupt the
  // next write on the other.
  const { sessions, spawned } = harness();
  const chunks = [];
  sessions.open({ onChunk: (t) => chunks.push(t), onExit() {} });

  const out = Buffer.from('é', 'utf8');
  spawned[0].child.stdout.emit('data', out.subarray(0, 1));
  spawned[0].child.stderr.emit('data', Buffer.from('E', 'utf8'));
  spawned[0].child.stdout.emit('data', out.subarray(1));

  assert.equal(chunks.join(''), 'Eé');
});
