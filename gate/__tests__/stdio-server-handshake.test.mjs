import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createStdioServer } from '../core/cli-environments/stdio-server.mjs';
import { createWindowsJob } from '../core/cli-environments/windows-job.mjs';

const CODEX_ADAPTER = {
  adapterId: 'codex',
  server: {
    transport: 'stdio',
    args: () => ['app-server'],
    handshake: { method: 'initialize', params: {} },
  },
};

const record = {
  id: 'codex-local',
  adapterId: 'codex',
  executable: { path: 'C:\\codex.exe' },
  lifecycle: { startup: 'on_demand' },
  workspacePolicy: { defaultRoot: 'C:\\Projects\\Versutus' },
};

/** `codex app-server` that starts and then never answers `initialize`. */
function muteChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = () => {};
  child.kills = 0;
  child.kill = () => { child.kills += 1; child.emit('exit', null); };
  return child;
}

/** An app-server that answers every request, as a healthy one does. */
function answeringChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.kills = 0;
  child.kill = () => { child.kills += 1; child.emit('exit', 0); };
  child.stdin.write = (line) => {
    const request = JSON.parse(line);
    setImmediate(() => child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`));
  };
  return child;
}

/** An app-server that dies during the handshake. */
function dyingChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = () => {};
  child.kills = 0;
  child.kill = () => { child.kills += 1; };
  setImmediate(() => child.emit('exit', 1));
  return child;
}

/**
 * The real job, off Windows so terminating a child is the direct kill and
 * nothing is shelled out to. Its own `children`/`terminated` are what the
 * supervisor hands over and keeps, so they are what a leak shows up in.
 */
function server({ spawn, handshakeTimeoutMs = 30_000 }) {
  const children = [];
  const job = createWindowsJob({ platform: 'linux' });
  const subject = createStdioServer({
    record,
    adapter: CODEX_ADAPTER,
    job,
    handshakeTimeoutMs,
    spawnImpl: () => { const child = spawn(); children.push(child); return child; },
  });
  return { subject, children, job };
}

// A CLI whose app-server starts but never completes the handshake — a first-run
// login prompt, a hung binary, an incompatible build. `handle` is never assigned,
// so every ensureRunning() spawns another process, and the manager's backoff
// makes it do that sooner rather than later: the host ends up carrying a dozen
// silent app-servers, each holding a pipe and a chunk of memory, none reachable.

test('an app-server that never finishes its handshake is reaped, and the retry starts from nothing', async () => {
  const { subject, children, job } = server({ spawn: muteChild, handshakeTimeoutMs: 25 });

  await assert.rejects(() => subject.ensureRunning(), /initialize timed out/);

  assert.ok(children[0].kills > 0, 'the mute child must be stopped, not abandoned');
  assert.equal(subject.isOwned(), false, 'the refusal leaves no live child behind');

  await assert.rejects(() => subject.ensureRunning(), /initialize timed out/);

  assert.equal(children.length, 2, 'the retry spawns exactly one new child');
  assert.ok(children[1].kills > 0, 'and reaps that one too');
  assert.deepEqual(job.children, [], 'neither generation is left for a later terminate');
});

test('an app-server that dies during the handshake leaves nothing live to retry around', async () => {
  let attempt = 0;
  const { subject, children, job } = server({ spawn: () => (attempt += 1) === 1 ? dyingChild() : answeringChild() });

  await assert.rejects(() => subject.ensureRunning(), /app-server exited|exited with code 1/i);

  assert.equal(subject.isOwned(), false, 'no live child is left behind');
  assert.deepEqual(job.children, [], 'and its dead pid is not left for a later terminate');

  const handle = await subject.ensureRunning();
  assert.ok(handle.rpc, 'the retry gets a working app-server');
  assert.equal(children.length, 2, 'spawning exactly one new child');
  assert.deepEqual(job.children, [children[1]], 'the job holds only the live generation');
});
