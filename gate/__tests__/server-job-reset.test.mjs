import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createStdioServer } from '../core/cli-environments/stdio-server.mjs';
import { createNativeServer } from '../core/cli-environments/native-server.mjs';
import { createWindowsJob } from '../core/cli-environments/windows-job.mjs';

// A supervisor creates its job once and hands it every child it spawns, and
// `terminate()` keeps every pid it was given and latches. Across a stop/start
// cycle the second terminate therefore ran taskkill /T /F against the first
// generation's pids: dead pids, which Windows recycles, so an unrelated process
// could be taken down by a cancel aimed at nothing.

test('a stdio server that restarts does not reap the generation it already stopped', async () => {
  const children = [];
  const job = createWindowsJob({ platform: 'linux' });
  const server = createStdioServer({
    record: {
      id: 'codex-local',
      adapterId: 'codex',
      executable: { path: 'C:\\codex.exe' },
      workspacePolicy: { defaultRoot: 'C:\\Projects\\Versutus' },
    },
    adapter: {
      adapterId: 'codex',
      server: { transport: 'stdio', args: () => ['app-server'], handshake: { method: 'initialize' } },
    },
    job,
    spawnImpl: () => { const child = answeringChild(); children.push(child); return child; },
  });

  await server.ensureRunning();
  await server.stop();
  assert.deepEqual(job.children, [], 'the stopped generation is forgotten');

  await server.ensureRunning();
  assert.deepEqual(job.children, [children[1]], 'the job holds exactly the live generation');
  const deadKills = children[0].kills;

  await server.stop();

  assert.ok(children[1].kills > 0, 'the live generation is stopped');
  assert.equal(children[0].kills, deadKills, 'and the dead pid is never taskkilled again');
  assert.deepEqual(job.children, [], 'the job ends empty for the next cycle');
});

test('an HTTP server that restarts does not reap the generation it already stopped', async () => {
  const children = [];
  const job = createWindowsJob({ platform: 'linux' });
  const server = createNativeServer({
    record: {
      id: 'opencode-local',
      adapterId: 'opencode',
      executable: { path: 'C:\\opencode.exe' },
      workspacePolicy: { defaultRoot: 'C:\\Projects\\Versutus' },
    },
    adapter: {
      adapterId: 'opencode',
      server: {
        defaultPort: 4096,
        healthPath: '/session',
        args: (port) => ['serve', '--port', String(port)],
        portFromOutput: () => '4599',
      },
    },
    job,
    spawnImpl: () => { const child = announcingChild(); children.push(child); return child; },
    fetchImpl: async (url) => {
      if (String(url).includes('4599')) return { ok: true, status: 200, async json() { return []; } };
      throw new Error('ECONNREFUSED');
    },
  });

  await server.ensureRunning();
  await server.stop();
  assert.deepEqual(job.children, [], 'the stopped generation is forgotten');

  await server.ensureRunning();
  assert.deepEqual(job.children, [children[1]], 'the job holds exactly the live generation');
  const deadKills = children[0].kills;

  await server.stop();

  assert.ok(children[1].kills > 0, 'the live generation is stopped');
  assert.equal(children[0].kills, deadKills, 'and the dead pid is never taskkilled again');
  assert.deepEqual(job.children, [], 'the job ends empty for the next cycle');
});

test('a job forgets its children when a supervisor is reset for the next generation', async () => {
  const job = createWindowsJob({ platform: 'linux' });
  let kills = 0;
  job.add({ pid: 1, kill: () => { kills += 1; } });

  await job.terminate();
  assert.equal(job.terminated, true);

  job.reset();
  assert.deepEqual(job.children, [], 'no stale pid survives into the next generation');
  assert.equal(job.terminated, false, 'and a terminated job can terminate again');

  await job.terminate();
  assert.equal(kills, 1, 'which is what makes the second stop possible at all');
});

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

/** `opencode serve`, which announces the port it came up on. */
function announcingChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = 0;
  child.kill = () => { child.kills += 1; child.emit('exit', 0); };
  setTimeout(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4599\n'), 5);
  return child;
}
