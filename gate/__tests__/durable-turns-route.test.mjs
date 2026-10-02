import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';
import { DeviceTokenStore } from '../core/device-tokens.mjs';
import { createTurnJournal } from '../core/turns/turn-journal.mjs';

// A turn belongs to the Gate, not to the phone that asked for it
// (docs/design/durable-turns.md). These drive a real Gate over HTTP with a
// backend whose turns the test holds open, because every one of the claims is
// about what a second request can see while the first one is still running.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all([...new Set(roots.splice(0))].map((root) => rm(root, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 20,
  })));
});

const SESSION = {
  id: 'ses_1',
  source: 'stubcli',
  user_id: null,
  model: null,
  title: 'Stub session',
  started_at: 1,
  ended_at: null,
  end_reason: null,
  message_count: 0,
  tool_call_count: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  estimated_cost_usd: null,
  actual_cost_usd: null,
  api_call_count: 0,
  parent_session_id: null,
  last_active: 1,
  preview: null,
  has_system_prompt: false,
  has_model_config: false,
};

const answer = (text) => ({ text, message: { role: 'assistant', content: [{ type: 'text', text }] } });

/**
 * An adapter whose turn behaviour the test controls: every `sendMessage` parks
 * until the test resolves it, recording the abort signal so "was this turn
 * cancelled?" is observable.
 */
function stubTurnRegistry(turns, { delta } = {}) {
  // The runner subscribes and then sends with no await in between, so the feed
  // signal and the send of one turn are adjacent and a queue pairs them up.
  const signals = [];
  const adapter = {
    adapterId: 'stubcli',
    adapterRevision: '1',
    supportedCliVersions: '1.x',
    protocolVersions: { acp: '1' },
    capabilities: ['sessions', 'tools', 'models'],
    server: { defaultPort: 1, healthPath: '/', args: () => [], portFromOutput: () => null },
    async probe() { return { state: 'ready', cliVersion: '1.0.0', protocol: 'acp' }; },
    createBackend() {
      return {
        async listSessions() { return [SESSION]; },
        async createSession(input) { return { ...SESSION, title: input?.title ?? null }; },
        async deleteSession() {},
        async listMessages() { return []; },
        async sendMessage(id, input) {
          return new Promise((resolve) => {
            turns.push({ resolve, signal: signals.shift(), text: input?.text });
          });
        },
        async listModels() { return []; },
        async abort() {},
        async replyApproval() {},
        async streamEvents(id, onEvent, signal) {
          signals.push(signal);
          if (delta) onEvent({ type: 'message.delta', payload: { text: delta } });
          return new Promise((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener('abort', resolve, { once: true });
          });
        },
      };
    },
  };
  return {
    get(id) { if (id !== 'stubcli') throw new Error(`unknown CLI adapter "${id}"`); return adapter; },
    list() { return [adapter]; },
  };
}

async function makeGate({ turns = [], registry, pushFetch, gateOptions, pairedDevices = [], root: givenRoot } = {}) {
  const root = givenRoot ?? await mkdtemp(join(tmpdir(), 'gate-durable-'));
  roots.push(root);
  const gateHome = join(root, '.gate-home');
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });
  await writeFile(join(gateHome, 'config', 'environments', 'stub-local.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'cli-environment',
    id: 'stub-local',
    label: 'Stub stubcli',
    adapterId: 'stubcli',
    executable: { path: 'C:\\stub.exe' },
    protocolPreference: ['acp'],
    versionPolicy: { supported: '1.x', adapterRevision: '1' },
    providerRefs: [],
    workspacePolicy: { roots: ['C:\\ws'], defaultRoot: 'C:\\ws', defaultSandbox: 'workspace_write', allowAdditionalRoots: false },
    lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 1 },
    enabled: true,
  }), 'utf8');

  // A second caller identity, issued before the Gate starts: the device grant
  // is the only thing that separates one phone's turn from another's.
  const deviceTokens = new DeviceTokenStore(join(root, '.device-tokens.json'));
  const paired = {};
  for (const deviceId of pairedDevices) {
    paired[deviceId] = await deviceTokens.issue(deviceId, { role: 'operator', scopes: ['operator.read'] });
  }

  const gate = await createGate({
    root,
    port: 0,
    gateHome,
    environmentRegistry: registry ?? stubTurnRegistry(turns),
    backendServerFactory: () => ({
      ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:1', attached: true }),
      stop: async () => {},
      isOwned: () => false,
    }),
    ...(pushFetch ? { pushFetch } : {}),
    ...(gateOptions ?? {}),
  });
  let closed = false;
  return {
    gate,
    turns,
    paired,
    root,
    gateHome,
    base: `http://127.0.0.1:${gate.port}`,
    // A test that closes the Gate to watch a restart still has to be able to
    // clean up, and Node answers a second `server.close()` with an error.
    close: () => (closed ? Promise.resolve() : (closed = true, gate.close())),
  };
}

function auth(gate) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` };
}

const TURN_ID = 'turn-abc-123';

const streamingTurn = (gate, { turnId, controller, text = 'say it once', sessionId = 'ses_1', token } = {}) => fetch(
  `http://127.0.0.1:${gate.port}/v1/chat/completions`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token ?? gate.token}`,
      ...(turnId ? { 'X-Versutus-Turn-Id': turnId } : {}),
    },
    signal: controller?.signal,
    body: JSON.stringify({
      backendId: 'stub-local', ...(sessionId ? { sessionId } : {}),
      messages: [{ role: 'user', content: text }], stream: true,
    }),
  },
);

const turnMeta = async (gate, turnId, token = gate.gate.token) => {
  const response = await fetch(`${gate.base}/v1/turns/${turnId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json() };
};

/** Bounded poll: the seams under test (push delivery, abort) are async. */
const until = async (predicate, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The `data:` payloads of an SSE body, in order.
 *
 * A frame is one `data:` line, however many other lines precede it: a replay
 * prefixes each with `id: <seq>` and the live stream does not.
 */
const framesOf = (body) => body.split('\n\n')
  .map((frame) => frame.split('\n').find((line) => line.startsWith('data: ')))
  .filter(Boolean);

// ─── What the Gate recorded while the phone was listening ──────────────────

test('a streamed turn is journalled, and a replay carries the same frames', async () => {
  const turns = [];
  const gate = await makeGate({ registry: stubTurnRegistry(turns) });
  try {
    // Not awaited: a response that has written nothing yet has not sent its
    // status line either, so a test that waits for the turn to speak must not
    // wait on the response first.
    const live = streamingTurn(gate.gate, { turnId: TURN_ID });
    await until(() => turns.length === 1);
    turns[0].resolve(answer('the whole answer'));
    const liveBody = await (await live).text();
    assert.match(liveBody, /the whole answer/);
    assert.ok(liveBody.endsWith('data: [DONE]\n\n'));

    const { status, body } = await turnMeta(gate, TURN_ID);
    assert.equal(status, 200);
    assert.equal(body.status, 'done');
    assert.equal(body.sessionId, 'ses_1');
    assert.equal(body.text, 'the whole answer');
    assert.equal(body.turnId, TURN_ID);

    // The replay reproduces the frames the live stream carried, in order, each
    // prefixed with its sequence number, and ends at [DONE].
    const replay = await fetch(`${gate.base}/v1/turns/${TURN_ID}/events?after=0`, {
      headers: auth(gate.gate),
    });
    assert.match(replay.headers.get('content-type'), /text\/event-stream/);
    const replayBody = await replay.text();
    assert.deepEqual(framesOf(replayBody), framesOf(liveBody), 'a replay is the frames the live stream got');
    assert.equal(framesOf(replayBody).at(-1), 'data: [DONE]');
    assert.match(replayBody, /id: \d+\n/, 'every replayed frame carries its sequence number');

    // `after` is how the app re-attaches from its last seen frame.
    const tail = await (await fetch(`${gate.base}/v1/turns/${TURN_ID}/events?after=1`, {
      headers: auth(gate.gate),
    })).text();
    assert.ok(!tail.includes('the whole answer'), 'a replay after the frame it has seen does not repeat it');
    assert.ok(tail.endsWith('data: [DONE]\n\n'));
  } finally {
    await gate.close();
  }
});

test('GET /v1/turns filters by session and status, newest first', async () => {
  const turns = [];
  const gate = await makeGate({ registry: stubTurnRegistry(turns) });
  const list = async (query) => (await fetch(`${gate.base}/v1/turns${query}`, {
    headers: auth(gate.gate),
  })).json();
  try {
    const finished = streamingTurn(gate.gate, { turnId: 'turn-finished-1', sessionId: 'ses_1' });
    finished.catch(() => undefined);
    await until(() => turns.length === 1);
    turns[0].resolve(answer('one'));
    await finished;
    const running = streamingTurn(gate.gate, { turnId: 'turn-running-1', sessionId: 'ses_2' });
    running.catch(() => undefined);
    await until(() => turns.length === 2);

    const all = await list('');
    assert.equal(all.object, 'list');
    assert.deepEqual(all.data.map((meta) => meta.turnId), ['turn-running-1', 'turn-finished-1']);
    assert.equal(all.data[0].text, undefined, 'the list carries meta, not the assembled text');

    assert.deepEqual((await list('?sessionId=ses_1')).data.map((meta) => meta.turnId), ['turn-finished-1']);
    assert.deepEqual((await list('?status=running')).data.map((meta) => meta.turnId), ['turn-running-1']);
    assert.deepEqual((await list('?status=done')).data.map((meta) => meta.turnId), ['turn-finished-1']);
    assert.deepEqual((await list('?sessionId=ses_2&status=done')).data, []);
  } finally {
    await gate.close();
  }
});

test('Stop is journalled as cancelled', async () => {
  const turns = [];
  const gate = await makeGate({ registry: stubTurnRegistry(turns) });
  try {
    const pending = streamingTurn(gate.gate, { turnId: TURN_ID });
    pending.catch(() => undefined);
    await until(() => turns.length === 1);
    const stopped = await fetch(`${gate.base}/v1/chat/cancel`, {
      method: 'POST',
      headers: auth(gate.gate),
      body: JSON.stringify({ turnId: TURN_ID }),
    });
    assert.deepEqual(await stopped.json(), { cancelled: true });
    await until(() => turns[0].signal?.aborted === true);

    assert.equal((await turnMeta(gate, TURN_ID)).body.status, 'cancelled');
    await pending;
  } finally {
    await gate.close();
  }
});

// ─── A phone that left: the turn belongs to the Gate ───────────────────────

test('a detached turn finishes on the Gate and can be replayed afterwards', async () => {
  const turns = [];
  // Bounds an order of magnitude larger than the test: this is about what a
  // close does NOT start, so nothing here may fire.
  const gate = await makeGate({
    registry: stubTurnRegistry(turns),
    gateOptions: { detachedTurnMaxMs: 30_000, detachedStallMs: 30_000 },
  });
  const controller = new AbortController();
  try {
    const pending = streamingTurn(gate.gate, { turnId: TURN_ID, controller });
    pending.catch(() => undefined);
    await until(() => turns.length === 1);
    // The phone is backgrounded: the socket dies mid-turn, with no Stop.
    controller.abort();
    await pending.catch(() => undefined);
    await sleep(50);
    assert.equal(turns[0].signal?.aborted, false, 'a dropped socket must not cancel a named turn');

    turns[0].resolve(answer('the whole answer'));
    assert.ok(
      await until(async () => (await turnMeta(gate, TURN_ID)).body.status === 'done'),
      'the turn must run to its own end with nobody watching',
    );
    assert.equal((await turnMeta(gate, TURN_ID)).body.text, 'the whole answer');
  } finally {
    await gate.close();
  }
});

test('a turn already older than the ceiling when the phone left is not aborted', async () => {
  const turns = [];
  // The old arithmetic armed `maxMs - (now - startedAt)` on the close, so a turn
  // that had been attached longer than the bound was killed the instant the
  // socket closed. How long a turn ran attached says nothing about whether it is
  // still working, so the ceiling is armed in full, from the moment it detached.
  const gate = await makeGate({
    registry: stubTurnRegistry(turns),
    gateOptions: { detachedTurnMaxMs: 200, detachedStallMs: 30_000 },
  });
  const controller = new AbortController();
  try {
    const pending = streamingTurn(gate.gate, { turnId: TURN_ID, controller });
    pending.catch(() => undefined);
    await until(() => turns.length === 1);
    await sleep(400);
    assert.ok(turns[0].signal?.aborted === false);

    controller.abort();
    await pending.catch(() => undefined);
    turns[0].resolve(answer('the whole answer'));
    assert.ok(
      await until(() => turns[0].signal?.aborted === false),
      'a healthy detached turn must not be aborted on the arithmetic that used to do it',
    );
    assert.equal((await turnMeta(gate, TURN_ID)).body.status, 'done');
  } finally {
    await gate.close();
  }
});

test('a detached turn that goes quiet is recorded as interrupted/stalled', async () => {
  const turns = [];
  const gate = await makeGate({
    registry: stubTurnRegistry(turns),
    gateOptions: { detachedStallMs: 40, detachedTurnMaxMs: 30_000 },
  });
  const controller = new AbortController();
  try {
    const pending = streamingTurn(gate.gate, { turnId: TURN_ID, controller });
    pending.catch(() => undefined);
    await until(() => turns.length === 1);
    controller.abort();
    await pending.catch(() => undefined);
    assert.ok(await until(() => turns[0].signal?.aborted === true), 'a silent turn is ended, not waited on forever');

    const { body } = await turnMeta(gate, TURN_ID);
    assert.equal(body.status, 'interrupted');
    assert.equal(body.reason, 'stalled');
  } finally {
    await gate.close();
  }
});

test('a Gate-ended turn is on record as an error frame, so a follower and a replay never see a half answer finish', async () => {
  const turns = [];
  const gate = await makeGate({
    registry: stubTurnRegistry(turns, { delta: 'half an ' }),
    gateOptions: { detachedStallMs: 250, detachedTurnMaxMs: 30_000 },
  });
  const controller = new AbortController();
  try {
    const pending = streamingTurn(gate.gate, { turnId: TURN_ID, controller });
    pending.catch(() => undefined);
    await until(() => turns.length === 1);
    controller.abort();
    await pending.catch(() => undefined);

    // A phone that comes back while the turn is still running follows it live.
    const follow = await fetch(`${gate.base}/v1/turns/${TURN_ID}/events?after=0`, { headers: auth(gate.gate) });
    const followed = framesOf(await follow.text());
    const errorAt = followed.findIndex((frame) => frame.includes('turn_stalled'));
    assert.ok(errorAt >= 0, `the follower is told the turn was ended: ${followed.join(' | ')}`);
    assert.ok(errorAt < followed.indexOf('data: [DONE]'), 'the error frame comes before the end of the stream');

    // And the record says the same to a replay that starts after it ended.
    const replay = await fetch(`${gate.base}/v1/turns/${TURN_ID}/events?after=0`, { headers: auth(gate.gate) });
    const replayed = framesOf(await replay.text());
    assert.ok(replayed.some((frame) => frame.includes('turn_stalled')), `a replay carries it too: ${replayed.join(' | ')}`);
    assert.equal((await turnMeta(gate, TURN_ID)).body.status, 'interrupted');
  } finally {
    await gate.close();
  }
});

test('the safety ceiling is recorded as interrupted/max_age', async () => {
  const turns = [];
  const gate = await makeGate({
    registry: stubTurnRegistry(turns),
    gateOptions: { detachedStallMs: 30_000, detachedTurnMaxMs: 40 },
  });
  const controller = new AbortController();
  try {
    const pending = streamingTurn(gate.gate, { turnId: TURN_ID, controller });
    pending.catch(() => undefined);
    await until(() => turns.length === 1);
    controller.abort();
    await pending.catch(() => undefined);
    assert.ok(await until(() => turns[0].signal?.aborted === true), 'a turn nobody is watching must not run forever');

    const { body } = await turnMeta(gate, TURN_ID);
    assert.equal(body.status, 'interrupted');
    assert.equal(body.reason, 'max_age');
  } finally {
    await gate.close();
  }
});

/**
 * A backend whose tool cards the test drives by hand, so the ordering that
 * matters can be built exactly: the phone leaves FIRST, and the tool starts
 * afterwards.
 */
function toolTurnRegistry(turns, feeds) {
  const signals = [];
  const adapter = {
    ...stubTurnRegistry(turns).get('stubcli'),
    createBackend() {
      return {
        async listSessions() { return [SESSION]; },
        async createSession(input) { return { ...SESSION, title: input?.title ?? null }; },
        async sendMessage(id, input) {
          return new Promise((resolve) => {
            turns.push({ resolve, signal: signals.shift(), text: input?.text });
          });
        },
        async listModels() { return []; },
        async streamEvents(id, onEvent, signal) {
          signals.push(signal);
          feeds.push(onEvent);
          return new Promise((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener('abort', resolve, { once: true });
          });
        },
      };
    },
  };
  return { get: () => adapter, list: () => [adapter] };
}

test('a tool that keeps reporting after the phone left holds the stall watchdog off', async () => {
  const turns = [];
  const feeds = [];
  const gate = await makeGate({
    registry: toolTurnRegistry(turns, feeds),
    gateOptions: { detachedStallMs: 120, detachedTurnMaxMs: 30_000 },
  });
  const controller = new AbortController();
  try {
    const pending = streamingTurn(gate.gate, { turnId: TURN_ID, controller });
    pending.catch(() => undefined);
    assert.ok(await until(() => turns.length === 1));
    assert.ok(await until(() => feeds.length === 1));
    // The phone is backgrounded FIRST, so the watchdog is armed at the detach
    // before the tool exists: the tool's first frame must re-arm it, not race
    // the timer already counting down.
    controller.abort();
    await pending.catch(() => undefined);
    feeds[0]({ type: 'tool.started', payload: { name: 'bash', callId: 'call-1' } });

    // Well past the stall bound, with the model saying no text at all: a turn
    // running a long tool and reporting it is working, not hanging.
    for (let tick = 0; tick < 10; tick += 1) {
      feeds[0]({ type: 'tool.progress', payload: { callId: 'call-1', text: `step ${tick} ` } });
      await sleep(60);
      assert.equal(
        turns[0].signal?.aborted,
        false,
        `a running tool was read as a stall after ${(tick + 1) * 60}ms`,
      );
    }

    turns[0].resolve(answer('done after the tool'));
    assert.ok(
      await until(async () => (await turnMeta(gate, TURN_ID)).body.status === 'done'),
      'a turn that was holding a tool still finished',
    );
  } finally {
    await gate.close();
  }
});

test('a tool that never reports an end is a stall once the turn goes quiet', async () => {
  const turns = [];
  const feeds = [];
  const gate = await makeGate({
    registry: toolTurnRegistry(turns, feeds),
    gateOptions: { detachedStallMs: 60, detachedTurnMaxMs: 30_000 },
  });
  const controller = new AbortController();
  try {
    const pending = streamingTurn(gate.gate, { turnId: TURN_ID, controller });
    pending.catch(() => undefined);
    assert.ok(await until(() => turns.length === 1));
    assert.ok(await until(() => feeds.length === 1));
    controller.abort();
    await pending.catch(() => undefined);
    // A tool card the backend opens and never closes, saying nothing since: the
    // clock is held off by progress, not by the tool being open.
    feeds[0]({ type: 'tool.started', payload: { name: 'bash', callId: 'call-1' } });

    assert.ok(
      await until(() => turns[0].signal?.aborted === true),
      'a tool that never ends must not hold the watchdog off forever',
    );
    const { body } = await turnMeta(gate, TURN_ID);
    assert.equal(body.status, 'interrupted');
    assert.equal(body.reason, 'stalled');
  } finally {
    await gate.close();
  }
});

test('the detached-turn count is a runaway guard, not a reaper', async () => {
  const turns = [];
  const gate = await makeGate({
    registry: stubTurnRegistry(turns),
    gateOptions: { detachedTurnMaxMs: 30_000, detachedStallMs: 30_000, detachedTurnLimit: 8 },
  });
  const controllers = Array.from({ length: 9 }, () => new AbortController());
  try {
    const pendings = controllers.map((controller, index) => streamingTurn(gate.gate, {
      turnId: `turn-detached-${index}`, controller, text: `turn number ${index}`,
    }));
    pendings.forEach((pending) => pending.catch(() => undefined));
    assert.ok(await until(() => turns.length === 9), `only ${turns.length} of 9 turns started`);

    // One at a time, so which close crossed the guard is unambiguous.
    for (let index = 0; index < controllers.length; index += 1) {
      controllers[index].abort();
      await sleep(30);
      assert.deepEqual(
        turns.filter((turn) => turn.signal?.aborted).map((turn) => turn.text),
        [],
        `turn number ${index} was cancelled by the guard; a refused detach must leave it running`,
      );
    }
    // All nine are still running, and all nine are on record as running.
    const running = await (await fetch(`${gate.base}/v1/turns?status=running`, { headers: auth(gate.gate) })).json();
    assert.equal(running.data.length, 9);
  } finally {
    await gate.close();
  }
});

// ─── A restart is an honest end, recorded ─────────────────────────────────

test('a restart pushes the phone that walked away a notice, not silence', async () => {
  // The detach contract is that the turn keeps working on the PC while the phone
  // is gone, so a restart has to reach that phone somehow. It did not: the
  // abort close() sent was indistinguishable from the user's own Stop, which
  // reports an aborted turn as contentless and answers `null` — the "no notice"
  // signal the route reads. The turn's real work was cancelled and nothing said
  // so anywhere except the journal.
  const turns = [];
  const pushSends = [];
  const pushFetch = async (url, init) => {
    if (url.endsWith('/push/send')) {
      const messages = JSON.parse(init.body);
      pushSends.push(...messages);
      return {
        ok: true, status: 200,
        async json() { return { data: messages.map((_, index) => ({ status: 'ok', id: `t-${index}` })) }; },
      };
    }
    return {
      ok: true, status: 200,
      async json() { return { data: Object.fromEntries(JSON.parse(init.body).ids.map((id) => [id, { status: 'ok' }])) }; },
    };
  };
  const gate = await makeGate({ registry: stubTurnRegistry(turns), pushFetch });
  const controller = new AbortController();
  try {
    for (const [method, params] of [
      ['notifications.register', { expoPushToken: 'ExponentPushToken[phone]', platform: 'ios', timezone: 'UTC', deviceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }],
      ['notifications.preferences.set', { enabled: true, richBody: true, deviceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }],
    ]) {
      const rpc = await fetch(`${gate.base}/v1/capabilities/rpc`, {
        method: 'POST', headers: auth(gate.gate), body: JSON.stringify({ method, params }),
      });
      assert.equal(rpc.status, 200);
    }

    const pending = streamingTurn(gate.gate, { turnId: TURN_ID, controller });
    pending.catch(() => undefined);
    assert.ok(await until(() => turns.length === 1));
    // The phone locks: the turn detaches and keeps working on the Gate.
    controller.abort();
    await pending.catch(() => undefined);
    assert.equal(turns[0].signal?.aborted, false, 'leaving is not a cancel');

    await gate.close();
    assert.equal(turns[0].signal?.aborted, true, 'the restart ends the work it was doing');

    assert.ok(
      await until(() => pushSends.length === 1),
      `a turn the phone walked away from must be told how it ended: ${JSON.stringify(pushSends)}`,
    );
    const notice = pushSends.find((message) => message.data?.kind === 'reply');
    assert.equal(notice.data.sessionId, 'ses_1');
    assert.match(notice.body, /stopped: gate_restart/);
  } finally {
    await gate.close();
  }
});

test('closing the Gate ends an attached turn with an error frame, not a [DONE]', async () => {
  const turns = [];
  const gate = await makeGate({ registry: stubTurnRegistry(turns, { delta: 'half an ' }) });
  try {
    const pending = streamingTurn(gate.gate, { turnId: TURN_ID });
    assert.ok(await until(() => turns.length === 1));
    await gate.close();
    const body = await (await pending).text();

    assert.match(body, /gate_restart/);
    assert.match(body, /The Gate restarted while this turn was running\./);
    assert.ok(!body.includes('[DONE]'), 'a restart must never end an attached stream as a success');
    assert.equal(turns[0].signal?.aborted, true, 'a restart is a named end for every live turn');

    // And the journal says the same thing, so the phone's next read agrees.
    const after = createTurnJournal({ dir: join(gate.gateHome, 'turns') });
    const known = await after.get('bootstrap-token', TURN_ID);
    assert.equal(known.status, 'interrupted');
    assert.equal(known.reason, 'gate_restart');
    assert.equal(known.text, 'half an ');

    // The frame is on the record, not only on the socket that was attached: a
    // phone that comes back after the restart replays the same ending.
    const replayed = [];
    const stop = await after.subscribe('bootstrap-token', TURN_ID, 0, (event) => {
      if (event) replayed.push(event.data);
    });
    stop?.();
    assert.ok(
      replayed.some((data) => data.includes('gate_restart')),
      `a replay after a restart carries the restart: ${replayed.join(' | ')}`,
    );
  } finally {
    await gate.close();
  }
});

test('a Gate that starts over settles the turn the last process left running', async () => {
  const turns = [];
  const gate = await makeGate({ registry: stubTurnRegistry(turns) });
  try {
    await gate.close();
    // A previous process, killed mid-turn: the journal still says `running`.
    const journal = createTurnJournal({ dir: join(gate.gateHome, 'turns') });
    journal.begin({ callerId: 'bootstrap-token', turnId: TURN_ID, sessionId: 'ses_1' })
      .append(JSON.stringify({ choices: [{ delta: { content: 'half an ' } }] }));
    await journal.close();

    // The next Gate starts, and its first act is to say what really happened.
    const restarted = await makeGate({
      registry: stubTurnRegistry([]),
      gateOptions: { turnsDir: join(gate.gateHome, 'turns') },
      root: gate.root,
    });
    try {
      const { body } = await turnMeta(restarted, TURN_ID);
      assert.equal(body.status, 'interrupted');
      assert.equal(body.reason, 'gate_restart');
      assert.equal(body.text, 'half an ', 'what it did manage to say is still readable');
      const listed = await (await fetch(`${restarted.base}/v1/turns`, { headers: auth(restarted.gate) })).json();
      assert.deepEqual(listed.data.map((meta) => meta.turnId), [TURN_ID]);
    } finally {
      await restarted.close();
    }
  } finally {
    await gate.close();
  }
});

// ─── Exactly once: a retry of an accepted send ────────────────────────────

test('a retry with the same turn id replays the turn and the backend runs once', async () => {
  const turns = [];
  const gate = await makeGate({ registry: stubTurnRegistry(turns) });
  try {
    const first = streamingTurn(gate.gate, { turnId: TURN_ID });
    first.catch(() => undefined);
    assert.ok(await until(() => turns.length === 1));
    turns[0].resolve(answer('the whole answer'));
    await first;

    // The retry is answered as a replay of the turn that already ran.
    const retry = await streamingTurn(gate.gate, { turnId: TURN_ID });
    assert.equal(retry.status, 200);
    assert.equal(retry.headers.get('x-versutus-turn-resumed'), '1');
    assert.equal(retry.headers.get('x-versutus-session-id'), 'ses_1');
    const body = await retry.text();
    assert.match(body, /the whole answer/);
    assert.ok(body.endsWith('data: [DONE]\n\n'));
    assert.equal(turns.length, 1, 'a retry must never run a second turn');
  } finally {
    await gate.close();
  }
});

test('a retry while the turn is still running follows it instead of starting one', async () => {
  const turns = [];
  // A delta on the opening frame, so both streams flush their status line and
  // the test can read a header while the turn is still running.
  const gate = await makeGate({ registry: stubTurnRegistry(turns, { delta: 'the whole ' }) });
  try {
    const first = streamingTurn(gate.gate, { turnId: TURN_ID });
    first.catch(() => undefined);
    assert.ok(await until(() => turns.length === 1));

    const retry = await streamingTurn(gate.gate, { turnId: TURN_ID });
    assert.equal(retry.status, 200);
    assert.equal(retry.headers.get('x-versutus-turn-resumed'), '1');
    assert.equal(turns.length, 1, 'the backend is not asked for a second turn');

    turns[0].resolve(answer('the whole answer'));
    await first;
    const followed = await retry.text();
    assert.match(followed, /the whole /);
    assert.ok(followed.endsWith('data: [DONE]\n\n'), 'the replay follows the turn to its end');
  } finally {
    await gate.close();
  }
});

test('two sends that race on one turn id run the turn once', async () => {
  const turns = [];
  const gate = await makeGate({ registry: stubTurnRegistry(turns, { delta: 'the whole ' }) });
  try {
    // The retry path checks the journal before routing, so two requests can both
    // find the id unused and then both start one (a double tap, an outbox resend
    // racing the original). Whichever loses must become a subscriber of the turn
    // that is running, not a second turn over the same record.
    const first = streamingTurn(gate.gate, { turnId: TURN_ID, text: 'the first send' });
    const second = streamingTurn(gate.gate, { turnId: TURN_ID, text: 'the same send again' });
    const responses = await Promise.all([first, second]);
    assert.ok(await until(() => turns.length >= 1));

    assert.equal(turns.length, 1, 'the backend was asked for exactly one turn');
    turns[0].resolve(answer('the whole answer'));
    const [live, replayed] = await Promise.all(responses.map(async (response) => response.text()));
    assert.deepEqual(
      framesOf(replayed),
      framesOf(live),
      'the loser carries the frames of the turn that is running',
    );
    assert.equal(framesOf(live).at(-1), 'data: [DONE]', 'and both requests end on a finished stream');
    assert.equal(
      responses.filter((response) => response.headers.get('x-versutus-turn-resumed') === '1').length,
      1,
      'the loser is told it is a replay, not a turn of its own',
    );
    const { body } = await turnMeta(gate, TURN_ID);
    assert.equal(body.status, 'done');
    assert.equal(body.text, 'the whole ', 'and one turn is on record, with the reply it really sent');
  } finally {
    await gate.close();
  }
});

test("one caller's turn is invisible to another", async () => {
  const turns = [];
  const gate = await makeGate({
    registry: stubTurnRegistry(turns),
    pairedDevices: ['phone-two'],
  });
  try {
    const pending = streamingTurn(gate.gate, { turnId: TURN_ID });
    pending.catch(() => undefined);
    assert.ok(await until(() => turns.length === 1));
    turns[0].resolve(answer('mine'));
    await pending;

    const other = gate.paired['phone-two'];
    const meta = await turnMeta(gate, TURN_ID, other);
    assert.equal(meta.status, 404);
    assert.equal(meta.body.error.code, 'unknown_turn');

    const events = await fetch(`http://127.0.0.1:${gate.gate.port}/v1/turns/${TURN_ID}/events`, {
      headers: { Authorization: `Bearer ${other}` },
    });
    assert.equal(events.status, 404);

    // And the id is still that other caller's to use for its own turn: a turn is
    // keyed by caller AND turn id, so a second phone minting the same id runs
    // its own turn rather than replaying this one.
    assert.deepEqual(await (await fetch(`${gate.base}/v1/turns`, {
      headers: { Authorization: `Bearer ${other}` },
    })).json(), { object: 'list', data: [] });

    const theirs = streamingTurn(gate.gate, {
      turnId: TURN_ID, text: 'a different question', token: other,
    });
    theirs.catch(() => undefined);
    assert.ok(await until(() => turns.length === 2), 'the other caller\'s turn must run on its own');
    turns[1].resolve(answer('a different answer'));
    assert.ok(
      await until(async () => (await turnMeta(gate, TURN_ID, other)).body.status === 'done'),
      'and it is recorded under the other caller',
    );
    assert.equal((await turnMeta(gate, TURN_ID, other)).body.text, 'a different answer');
    assert.equal((await turnMeta(gate, TURN_ID)).body.text, 'mine', 'the first turn is untouched');
  } finally {
    await gate.close();
  }
});

// ─── The reply the phone could not stream ─────────────────────────────────

test('the push after a detached completion carries the real reply', async () => {
  const turns = [];
  const pushSends = [];
  const pushFetch = async (url, init) => {
    if (url.endsWith('/push/send')) {
      const messages = JSON.parse(init.body);
      pushSends.push(...messages);
      return {
        ok: true, status: 200,
        async json() { return { data: messages.map((_, index) => ({ status: 'ok', id: `t-${index}` })) }; },
      };
    }
    return {
      ok: true, status: 200,
      async json() { return { data: Object.fromEntries(JSON.parse(init.body).ids.map((id) => [id, { status: 'ok' }])) }; },
    };
  };
  const gate = await makeGate({ registry: stubTurnRegistry(turns), pushFetch });
  const controller = new AbortController();
  try {
    for (const [method, params] of [
      ['notifications.register', { expoPushToken: 'ExponentPushToken[phone]', platform: 'ios', timezone: 'UTC', deviceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }],
      ['notifications.preferences.set', { enabled: true, richBody: true, deviceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }],
    ]) {
      const rpc = await fetch(`${gate.base}/v1/capabilities/rpc`, {
        method: 'POST', headers: auth(gate.gate), body: JSON.stringify({ method, params }),
      });
      assert.equal(rpc.status, 200);
    }

    // A reply well past the 2000-character sample the old code could carry.
    const reply = `the whole answer ${'and all of its later words'.repeat(200)}`;
    const pending = streamingTurn(gate.gate, { turnId: TURN_ID, controller });
    pending.catch(() => undefined);
    assert.ok(await until(() => turns.length === 1));
    controller.abort();
    await pending.catch(() => undefined);
    turns[0].resolve(answer(reply));

    assert.ok(await until(() => pushSends.length === 1), 'a detached turn that finished must still push');
    const notice = pushSends.find((message) => message.data?.kind === 'reply');
    assert.equal(notice.data.sessionId, 'ses_1');
    // The notifier's own 80-character cap, applied to the real reply.
    assert.equal(notice.body, `${reply.slice(0, 80)}…`);
    // And the whole thing is fetchable until retention, which a 2000-character
    // sample never was.
    assert.equal((await turnMeta(gate, TURN_ID)).body.text, reply);
  } finally {
    await gate.close();
  }
});

test('a push that cannot be delivered is logged, and never breaks the turn', async () => {
  const turns = [];
  const pushFetch = async (url) => {
    if (url.endsWith('/push/send')) throw new Error('Expo is unreachable');
    return { ok: true, status: 200, async json() { return { data: {} }; } };
  };
  const gate = await makeGate({ registry: stubTurnRegistry(turns), pushFetch });
  const controller = new AbortController();
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    for (const [method, params] of [
      ['notifications.register', { expoPushToken: 'ExponentPushToken[phone]', platform: 'ios', timezone: 'UTC', deviceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }],
      ['notifications.preferences.set', { enabled: true, richBody: true, deviceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }],
    ]) {
      await fetch(`${gate.base}/v1/capabilities/rpc`, {
        method: 'POST', headers: auth(gate.gate), body: JSON.stringify({ method, params }),
      });
    }
    const pending = streamingTurn(gate.gate, { turnId: TURN_ID, controller });
    pending.catch(() => undefined);
    assert.ok(await until(() => turns.length === 1));
    controller.abort();
    await pending.catch(() => undefined);
    turns[0].resolve(answer('the whole answer'));

    assert.ok(
      await until(() => warnings.some((line) => line.includes('Push delivery failed') && line.includes('Expo is unreachable'))),
      `a swallowed push failure is a failure nobody can diagnose (saw: ${warnings.join(' | ')})`,
    );
    assert.ok(warnings.every((line) => !line.includes('ExponentPushToken')), 'a log line never carries a token');
    assert.equal((await turnMeta(gate, TURN_ID)).body.status, 'done', 'the turn is unaffected');
  } finally {
    console.warn = realWarn;
    await gate.close();
  }
});

test('a phone leaving a replay does not touch the turn', async () => {
  const turns = [];
  const gate = await makeGate({ registry: stubTurnRegistry(turns, { delta: 'the whole ' }) });
  const controller = new AbortController();
  try {
    const pending = streamingTurn(gate.gate, { turnId: TURN_ID });
    pending.catch(() => undefined);
    assert.ok(await until(() => turns.length === 1));

    const replay = streamingTurn(gate.gate, { turnId: TURN_ID, controller });
    replay.catch(() => undefined);
    assert.equal((await replay).headers.get('x-versutus-turn-resumed'), '1');
    controller.abort();
    await sleep(50);
    assert.equal(turns[0].signal?.aborted, false, 'a phone walking away from a replay is still not a Stop');

    turns[0].resolve(answer('the whole answer'));
    assert.ok(
      await until(async () => (await turnMeta(gate, TURN_ID)).body.status === 'done'),
      'the turn the replay walked away from still finished',
    );
  } finally {
    await gate.close();
  }
});