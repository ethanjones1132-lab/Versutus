import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, getEventListeners } from 'node:events';

import { createClaudeCodeBackend, transcriptDirFor } from '../core/cli-environments/backends/claude-code.mjs';
import { runBackendTurn } from '../core/voice/turn-runner.mjs';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const SESSION_ID = '896a9c65-7554-453a-8e20-ccf419617968';

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'claude-home-abort-'));
  roots.push(home);
  const cwd = 'C:\\Projects\\Versutus';
  await mkdir(transcriptDirFor(home, cwd), { recursive: true });
  return { home, cwd };
}

/** A `claude --print` that never exits on its own: a turn still working. */
function workingChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = 0;
  child.kill = () => { child.kills += 1; child.emit('close', null); };
  return child;
}

/** A `claude --print` that answers and exits, the way a finished turn does. */
function finishedChild(lines = [{ type: 'result', subtype: 'success', result: 'claude ok' }]) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = 0;
  child.kill = () => { child.kills += 1; child.emit('close', null); };
  setTimeout(() => {
    for (const line of lines) child.stdout.emit('data', `${JSON.stringify(line)}\n`);
    child.emit('close', 0);
  }, 5);
  return child;
}

/** Jobs handed to the backend, so a test can see what each turn stopped. */
function recordingJobs() {
  const jobs = [];
  return {
    jobs,
    factory: () => {
      const job = {
        children: [],
        terminateCalls: 0,
        add(child) { this.children.push(child); },
        async terminate() { this.terminateCalls += 1; for (const child of this.children) child.kill(); },
      };
      jobs.push(job);
      return job;
    },
  };
}

/** Rejections that escape every handler, which must stay empty. */
async function withoutUncaught(run) {
  const uncaught = [];
  const record = (error) => uncaught.push(error);
  process.on('unhandledRejection', record);
  try {
    return { value: await run(), uncaught };
  } finally {
    process.off('unhandledRejection', record);
  }
}

const settled = (promise) => promise.then(() => null, (error) => error);

// ─── the turn's signal reaches the process ────────────────────────────────
// A Claude Code turn *is* a process: dropping the HTTP request that carries it
// ends the phone's view of the turn and nothing else. The agent keeps reading
// the workspace, keeps calling the vendor, and is joined by a second one on the
// next message. Only a kill reaches it.

test('a Stop mid-turn kills the claude process and rejects as a cancellation', async () => {
  const { home, cwd } = await makeHome();
  const child = workingChild();
  const jobs = recordingJobs();
  const backend = createClaudeCodeBackend({
    claudeHome: home, cwd, executablePath: 'claude.exe',
    spawnImpl: () => child,
    jobFactory: jobs.factory,
  });

  const caller = new AbortController();
  const turn = backend.sendMessage(SESSION_ID, { text: 'refactor everything', signal: caller.signal });
  await new Promise((resolve) => setImmediate(resolve));

  const { value, uncaught } = await withoutUncaught(async () => {
    caller.abort();
    return settled(turn);
  });

  assert.equal(value?.name, 'AbortError', 'a stopped turn is a cancellation, not a failed run');
  assert.equal(jobs.jobs.length, 1, 'each turn carries its own job');
  assert.equal(jobs.jobs[0].children[0], child, 'the job holds the turn being stopped');
  assert.equal(jobs.jobs[0].terminateCalls, 1, 'the whole tree is stopped, and once');
  assert.equal(child.kills, 1, 'the agent is not left running in the workspace');
  assert.deepEqual(uncaught, [], 'a stopped turn must not leave a rejection behind');
});

test('a turn handed an already-aborted signal is stopped before it can do anything', async () => {
  const { home, cwd } = await makeHome();
  const child = workingChild();
  const jobs = recordingJobs();
  const backend = createClaudeCodeBackend({
    claudeHome: home, cwd, executablePath: 'claude.exe',
    spawnImpl: () => child,
    jobFactory: jobs.factory,
  });
  const signal = AbortSignal.abort();

  const error = await settled(backend.sendMessage(SESSION_ID, { text: 'hi', signal }));

  assert.equal(error?.name, 'AbortError');
  assert.equal(child.kills, 1, 'the child spawned into an aborted turn is stopped at once');
  assert.equal(getEventListeners(signal, 'abort').length, 0, 'and no listener is left on it');
});

test('a turn that ends on its own leaves no abort listener and is never killed', async () => {
  const { home, cwd } = await makeHome();
  const child = finishedChild();
  const jobs = recordingJobs();
  const backend = createClaudeCodeBackend({
    claudeHome: home, cwd, executablePath: 'claude.exe',
    spawnImpl: () => child,
    jobFactory: jobs.factory,
  });
  const caller = new AbortController();

  const result = await backend.sendMessage(SESSION_ID, { text: 'hi', signal: caller.signal });

  assert.equal(result.text, 'claude ok', 'a normal turn still assembles its reply');
  assert.equal(
    getEventListeners(caller.signal, 'abort').length,
    0,
    'hundreds of turns must not stack listeners on the turn signal',
  );
  caller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.jobs[0]?.terminateCalls ?? 0, 0, 'an abort after the turn is over stops nothing');
  assert.equal(child.kills, 0, 'and never kills a process that already exited');
});

test('abort() stops the turn in flight and is a no-op between turns', async () => {
  const { home, cwd } = await makeHome();
  const child = workingChild();
  const jobs = recordingJobs();
  const backend = createClaudeCodeBackend({
    claudeHome: home, cwd, executablePath: 'claude.exe',
    spawnImpl: () => child,
    jobFactory: jobs.factory,
  });

  await backend.abort(); // nothing in flight

  const turn = backend.sendMessage(SESSION_ID, { text: 'refactor everything' });
  await new Promise((resolve) => setImmediate(resolve));
  await backend.abort();
  const error = await settled(turn);

  assert.equal(error?.name, 'AbortError', 'abort() ends the turn it can reach');
  assert.equal(jobs.jobs[0].terminateCalls, 1);
  assert.equal(child.kills, 1);

  await backend.abort();
  await backend.abort();
  assert.equal(jobs.jobs[0].terminateCalls, 1, 'abort() is idempotent once the turn is over');
});

// ─── what the phone is told ───────────────────────────────────────────────
// The runner races the send against the caller's abort, so a Stop ends the turn
// immediately. What the backend does about it afterwards must not turn into a
// failure on a call the user already stopped.

test('a Stop mid-turn ends the runner turn once and reports no failure', async () => {
  const { home, cwd } = await makeHome();
  const child = workingChild();
  const jobs = recordingJobs();
  const backend = createClaudeCodeBackend({
    claudeHome: home, cwd, executablePath: 'claude.exe',
    spawnImpl: () => child,
    jobFactory: jobs.factory,
  });
  const caller = new AbortController();
  const stages = [];
  const deltas = [];

  const turn = runBackendTurn(backend, SESSION_ID, { text: 'refactor everything' }, {
    signal: caller.signal,
    onDelta: (text) => deltas.push(text),
    onStage: (event) => stages.push(event.stage),
  });
  await new Promise((resolve) => setImmediate(resolve));
  caller.abort();

  const { value, uncaught } = await withoutUncaught(async () =>
    turn.then((outcome) => outcome, (error) => error));

  assert.equal(value?.name, undefined, `a stopped turn does not end as an error: ${value?.message}`);
  assert.equal(value?.aborted, true, 'the turn settles as stopped');
  assert.deepEqual(deltas, [], 'and reports no reply');
  assert.deepEqual(stages.filter((stage) => stage === 'turn.failed'), [], 'and no failure telemetry');
  assert.equal(child.kills, 1, 'the agent behind it is stopped all the same');

  // And the backend's own rejection, arriving after the turn is over, is
  // handled rather than left to crash the process.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(uncaught, []);
});

test('a backend that honours the signal is released by the same Stop', async () => {
  const caller = new AbortController();
  const stages = [];
  const seen = [];
  const backend = {
    sends: 0,
    async sendMessage(_sessionId, input, onEvent) {
      this.sends += 1;
      seen.push(input.signal);
      onEvent?.({ type: 'message.delta', payload: { text: 'working' } });
      const { signal } = input;
      return new Promise((_resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('stopped'), { name: 'AbortError' }));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
  const deltas = [];

  const turn = runBackendTurn(backend, 'ses_1', { text: 'hi' }, {
    signal: caller.signal,
    onDelta: (text) => deltas.push(text),
    onStage: (event) => stages.push(event.stage),
  });
  await new Promise((resolve) => setImmediate(resolve));
  caller.abort();

  const { value, uncaught } = await withoutUncaught(async () =>
    turn.then((outcome) => outcome, (error) => error));

  assert.ok(seen[0], 'the runner hands its turn signal to the backend, not only around it');
  assert.equal(backend.sends, 1, 'the turn is sent once and never re-sent');
  assert.equal(value?.name, undefined, `a stopped turn does not end as an error: ${value?.message}`);
  assert.equal(value?.aborted, true);
  assert.deepEqual(deltas, ['working'], 'only what came before the Stop is reported');
  assert.deepEqual(stages.filter((stage) => stage === 'turn.failed'), []);
  assert.deepEqual(uncaught, []);
});
