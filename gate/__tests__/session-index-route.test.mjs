import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate, createGateSessionIndex } from '../core/server.mjs';

// SPD-1/SPD-2, at the route. A Hermes session list is answered from the Gate's
// own copy and refilled in the background, because that list is the read every
// screen that shows threads waits on and it costs 3-38 s against a 6.2 GB
// `state.db` (2026-10-01). A read the copy can serve is instant; a read it
// cannot is bounded by what a screen will wait, and the read behind it keeps
// going.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ROW = (id, extra = {}) => ({
  id,
  source: 'hermes',
  user_id: null,
  model: null,
  title: `session ${id}`,
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
  ...extra,
});

/**
 * A backend whose session listing is entirely test-controlled: every call is
 * recorded, and `hold()` keeps the reads open — the 38 s cold read this exists for.
 */
function controllableBackend({ kind = 'hermes', bots = ['atlas'], listDelayMs = 0 } = {}) {
  const calls = [];
  const rows = [];
  let held = null;

  const backend = {
    kind,
    async listSessions(limit, options = {}) {
      calls.push({ listSessions: limit ?? null, timeoutMs: options.timeoutMs });
      if (held) await held.promise;
      // A catalogue read that takes real time, which is the shape the exact-id
      // lookup is not allowed to pay for.
      if (listDelayMs) await new Promise((resolve) => { setTimeout(resolve, listDelayMs); });
      return typeof limit === 'number' ? rows.slice(0, limit) : rows.slice();
    },
    async createSession({ title } = {}) {
      calls.push({ createSession: title ?? null });
      const created = ROW(`ses_${rows.length + 1}`, { title: title ?? null, last_active: 9 });
      rows.unshift(created);
      return created;
    },
    async deleteSession(id) {
      calls.push({ deleteSession: id });
      const at = rows.findIndex((row) => row.id === id);
      if (at !== -1) rows.splice(at, 1);
    },
    async listMessages() { return []; },
    async sendMessage() {
      return { text: 'a reply', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'a reply' }] } };
    },
    async listModels() { return []; },
    async abort() {},
    async replyApproval() {},
    async streamEvents() {},
    async forBot(botId) {
      calls.push({ forBot: botId });
      if (!bots.includes(botId)) throw Object.assign(new Error(`unknown bot "${botId}"`), { code: 'unknown_bot' });
      return scoped;
    },
  };
  const scoped = { ...backend, forBot: undefined };

  return {
    calls,
    /** Every session read, in order: the thing the copy has to make rare. */
    reads: () => calls.filter((call) => 'listSessions' in call),
    setRows: (next) => { rows.length = 0; rows.push(...next); },
    /** Keep the reads open until the returned handle is released. */
    hold() {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      held = { promise };
      return { release: () => { held = null; release(); } };
    },
    backend,
  };
}

async function makeGate({
  kind = 'hermes',
  adapterId = 'hermes',
  environmentId = 'hermes-local',
  // A clock behind the wall clock is how a test makes every window look stale
  // without waiting 30 s for it.
  indexNow,
  // The copy's write is coalesced; a test that has to prove WHEN it lands
  // (a shutdown, say) needs that delay to be longer than the test.
  indexWriteDelayMs,
  // A restart against the same home: a second Gate with a brand new index, which
  // is the only way a test can see what the copy knows when NOTHING has been
  // loaded into this process yet.
  reuse,
  // ...and `listDelayMs`, so a test can make the catalogue read cost real time.
  listDelayMs = 0,
  ...gateOptions
} = {}) {
  const root = reuse?.root ?? await mkdtemp(join(tmpdir(), 'gate-index-route-'));
  if (!reuse) roots.push(root);
  const gateHome = reuse?.gateHome ?? join(root, '.gate-home');
  if (!reuse) {
    await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
    await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
    await mkdir(join(root, 'registry'), { recursive: true });
    await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });
    await writeFile(join(gateHome, 'config', 'environments', `${environmentId}.json`), JSON.stringify({
      schemaVersion: 1, kind: 'cli-environment', id: environmentId, label: 'Stub Hermes',
      adapterId, executable: { path: 'C:\\stub.exe' }, protocolPreference: ['acp'],
      versionPolicy: { supported: '1.x', adapterRevision: '1' }, providerRefs: [],
      workspacePolicy: { roots: ['C:\\ws'], defaultRoot: 'C:\\ws', defaultSandbox: 'workspace_write', allowAdditionalRoots: false },
      lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 1 },
      enabled: true,
    }), 'utf8');
  }

  const hermes = controllableBackend({ kind, listDelayMs });
  const adapter = {
    adapterId,
    adapterRevision: '1',
    supportedCliVersions: '1.x',
    protocolVersions: { acp: '1' },
    capabilities: ['sessions', 'tools', 'models', 'bots'],
    server: { defaultPort: 1, healthPath: '/', args: () => [], portFromOutput: () => null },
    async probe() { return { state: 'ready', cliVersion: '1.0.0', protocol: 'acp' }; },
    createBackend: () => hermes.backend,
  };
  // The Gate builds its own copy; the test injects one built the same way so it
  // can drive the clock, rather than a differently-built index.
  const sessionIndex = createGateSessionIndex({
    gateHome,
    ...(indexNow ? { now: indexNow } : {}),
    ...(indexWriteDelayMs ? { writeDelayMs: indexWriteDelayMs } : {}),
  });

  const gate = await createGate({
    root,
    port: 0,
    gateHome,
    environmentRegistry: { get: (id) => { if (id !== adapterId) throw new Error(`unknown adapter "${id}"`); return adapter; }, list: () => [adapter] },
    backendServerFactory: () => ({
      ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:1', attached: true }),
      stop: async () => {},
      isOwned: () => false,
    }),
    sessionIndex,
    ...gateOptions,
  });
  return { gate, hermes, index: sessionIndex, environmentId, root, gateHome };
}

function auth(gate) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` };
}

function url(gate, path) {
  return `http://127.0.0.1:${gate.port}${path}`;
}

async function listSessions(gate, query = '', environmentId = 'hermes-local') {
  const started = Date.now();
  const response = await fetch(
    url(gate, `/v1/sessions?backendId=${environmentId}${query}`),
    { headers: auth(gate) },
  );
  return { status: response.status, ms: Date.now() - started, body: await response.json() };
}

async function sendTurn(gate, body) {
  const response = await fetch(url(gate, '/v1/chat/completions'), {
    method: 'POST',
    headers: auth(gate),
    body: JSON.stringify(body),
  });
  await response.text();
  return response.status;
}

async function rpc(gate, method, params = {}) {
  const response = await fetch(url(gate, '/v1/capabilities/rpc'), {
    method: 'POST',
    headers: auth(gate),
    body: JSON.stringify({ method, params }),
  });
  return { status: response.status, body: await response.json() };
}

async function waitFor(predicate, what) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('the first read waits for Hermes and answers what it returned', async () => {
  const { gate, hermes } = await makeGate();
  hermes.setRows([ROW('ses_1'), ROW('ses_2')]);
  try {
    const { status, body } = await listSessions(gate, '&limit=20');
    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.deepEqual(body.data.map((row) => row.id), ['ses_1', 'ses_2']);
    assert.equal(body.index.stale, false, 'a window just filled is not stale');
    // Two rows for a 20 ask: the Gate cannot tell a small catalogue from a
    // backend that served its own shorter page, so the honest mark is "short",
    // and the caller is the one who decides what a short page means.
    assert.equal(body.partial, true, 'a page that could not fill the limit is marked short');
    assert.deepEqual(hermes.reads(), [{ listSessions: 20, timeoutMs: 180_000 }], 'one live read, at the long bound a cold read needs');
  } finally {
    await gate.close();
  }
});

test('a second read answers from the Gate\'s own copy while Hermes is taking 5 s', async () => {
  // Every window this index writes looks a minute old, so the second read both
  // serves the copy and starts the background refill that is in the spec.
  const { gate, hermes } = await makeGate({ indexNow: () => Date.now() - 60_000 });
  hermes.setRows([ROW('ses_1'), ROW('ses_2')]);
  try {
    await listSessions(gate, '&limit=20');
    const held = hermes.hold();

    const second = await listSessions(gate, '&limit=20');
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.data.map((row) => row.id), ['ses_1', 'ses_2']);
    assert.equal(second.body.index.stale, true, 'and it says the copy is stale');
    assert.ok(second.ms < 100, `a warm list must be instant, took ${second.ms}ms`);

    // Two screens opening on a stale copy must cost ONE background read.
    const third = await listSessions(gate, '&limit=20');
    assert.ok(third.ms < 100, `a warm list must be instant, took ${third.ms}ms`);
    assert.equal(hermes.reads().length, 2, 'one live read plus one refill, not one per screen');

    held.release();
    await waitFor(() => hermes.reads().length === 2, 'the refill to be running');
  } finally {
    await gate.close();
  }
});

test('a read slower than the screen bound answers the wait, and the read behind it still lands', async () => {
  const { gate, hermes, index } = await makeGate({ sessionReadBoundMs: 60, sessionRefreshTimeoutMs: 5_000 });
  hermes.setRows([ROW('ses_1')]);
  try {
    const held = hermes.hold();
    const first = await listSessions(gate, '&limit=20');
    assert.equal(first.status, 502);
    assert.equal(first.body.error.code, 'backend_timeout');
    // The operator has to learn that the Gate is still working on it, not that
    // Hermes is broken: the same read that timed out on screen is still running.
    assert.match(first.body.error.message, /slow to list sessions/i);
    assert.match(first.body.error.message, /still reading them in the background/i);

    hermes.setRows([ROW('ses_1'), ROW('ses_2')]);
    held.release();
    await waitFor(
      async () => (await index.get('hermes-local|'))?.sessions.length === 2,
      'the read behind the screen to fill the copy',
    );

    // The read that the screen gave up on fills the copy, and the next read is
    // served from it without asking Hermes a second time.
    const later = await listSessions(gate, '&limit=20');
    assert.equal(later.status, 200);
    assert.deepEqual(later.body.data.map((row) => row.id), ['ses_1', 'ses_2']);
    assert.equal(hermes.reads().length, 1, 'the screen that gave up did not cost a second query');
  } finally {
    await gate.close();
  }
});

test('a copy with something in it answers partial rather than failing', async () => {
  const { gate, hermes } = await makeGate({ sessionReadBoundMs: 60, sessionIndexStaleMs: 0 });
  hermes.setRows([ROW('ses_1')]);
  try {
    await listSessions(gate, '&limit=20');
    const held = hermes.hold();

    // "Load older" needs rows the copy has never held, so it waits; the wait
    // ends without them, and what the Gate does know is still true.
    const older = await listSessions(gate, '&limit=200');
    assert.equal(older.status, 200);
    assert.deepEqual(older.body.data.map((row) => row.id), ['ses_1']);
    assert.equal(older.body.partial, true, 'a short page must say it is short');
    assert.equal(older.body.index.stale, true);
    assert.equal(hermes.reads().at(-1).listSessions, 200, 'the bigger read was really asked for');
    held.release();
  } finally {
    await gate.close();
  }
});

test('a limit larger than the copy was filled at waits for a bigger read', async () => {
  const { gate, hermes } = await makeGate();
  hermes.setRows(Array.from({ length: 30 }, (_, i) => ROW(`ses_${i + 1}`)));
  try {
    const first = await listSessions(gate, '&limit=20');
    assert.equal(first.body.data.length, 20, 'the page asked for is the page the backend was asked for');

    const older = await listSessions(gate, '&limit=200');
    assert.equal(older.status, 200);
    assert.equal(older.body.data.length, 30, 'a bigger ask gets the real window, not a short one');
    assert.equal(hermes.reads().at(-1).listSessions, 200);

    // The copy now holds the bigger window, so the next read of it is free.
    const warm = await listSessions(gate, '&limit=200');
    assert.equal(warm.body.data.length, 30);
    assert.equal(hermes.reads().length, 2, 'the third read asked Hermes nothing');
  } finally {
    await gate.close();
  }
});

test('a page the backend could not fill is marked short, whatever the copy believes', async () => {
  const { gate, hermes } = await makeGate();
  hermes.setRows(Array.from({ length: 30 }, (_, i) => ROW(`ses_${i + 1}`)));
  try {
    const first = await listSessions(gate, '&limit=200');
    assert.equal(first.status, 200);
    assert.equal(first.body.data.length, 30);
    // Hermes serves its own page when its own limit is the smaller one, and the
    // copy then believes it was filled at 200 — so nothing about the ask says
    // this page is short. The app compares the 30 rows it got with the 200 it
    // asked for, concludes nothing is older, and the operator's Bot Chat reads as
    // absent: so he opens a second one, which Hermes refuses by title.
    assert.equal(first.body.partial, true, '30 rows for a 200 ask is a short page and must say so');

    // And the read after it, answered from that same copy, is just as short.
    const warm = await listSessions(gate, '&limit=200');
    assert.equal(warm.body.data.length, 30);
    assert.equal(warm.body.partial, true, 'a page served out of the copy is short for the same reason');
  } finally {
    await gate.close();
  }
});

test('a page that filled the limit the caller sent is not marked short', async () => {
  const { gate, hermes } = await makeGate();
  hermes.setRows(Array.from({ length: 20 }, (_, i) => ROW(`ses_${i + 1}`)));
  try {
    const { status, body } = await listSessions(gate, '&limit=20');
    assert.equal(status, 200);
    assert.equal(body.data.length, 20);
    assert.equal(body.partial, undefined, 'the page the caller asked for is not marked short');
  } finally {
    await gate.close();
  }
});

test('a created session is the newest row of the next list, with no read at all', async () => {
  const { gate, hermes, environmentId } = await makeGate();
  hermes.setRows([ROW('ses_1')]);
  try {
    await listSessions(gate, '&limit=20');

    const created = await (await fetch(`http://127.0.0.1:${gate.port}/v1/sessions`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ backendId: environmentId, title: 'Brand new' }),
    })).json();
    assert.equal(created.title, 'Brand new');

    // Hermes cannot be asked again, and it must not have to be: the Gate knows
    // about this one because the operator just made it here.
    const held = hermes.hold();
    const after = await listSessions(gate, '&limit=20');
    assert.equal(after.status, 200);
    assert.deepEqual(after.body.data.map((row) => row.id), [created.id, 'ses_1']);
    assert.equal(hermes.reads().length, 1, 'the operator\'s own create is answered from the Gate, not from Hermes');
    held.release();
  } finally {
    await gate.close();
  }
});

test('a chat turn puts its session at the top of the next list, streamed or not', async () => {
  for (const stream of [false, true]) {
    const { gate, hermes, environmentId } = await makeGate();
    hermes.setRows([ROW('ses_1')]);
    try {
      await listSessions(gate, '&limit=20');

      const response = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
        method: 'POST',
        headers: auth(gate),
        body: JSON.stringify({
          backendId: environmentId,
          sessionId: 'ses_chat',
          messages: [{ role: 'user', content: 'hello' }],
          stream,
        }),
      });
      assert.equal(response.status, 200);
      await response.text();

      const held = hermes.hold();
      const after = await listSessions(gate, '&limit=20');
      assert.deepEqual(
        after.body.data.map((row) => row.id),
        ['ses_chat', 'ses_1'],
        `the turn (stream=${stream}) must be visible in the Gate's own copy`,
      );
      assert.equal(hermes.reads().length, 1, 'and it cost no session read');
      // A row the Gate wrote for itself is a whole row, because the app parses
      // these fields off it: a missing one is a hole in the list, not a zero.
      const turned = after.body.data[0];
      assert.equal(turned.id, 'ses_chat');
      assert.equal(typeof turned.started_at, 'number');
      assert.equal(turned.preview, '', 'no preview is empty, not absent');
      assert.equal(turned.message_count, 0);
      assert.equal(typeof turned.last_active, 'number');
      assert.equal(turned.has_system_prompt, false);
      held.release();
    } finally {
      await gate.close();
    }
  }
});

test('a deleted session disappears from the next list', async () => {
  const { gate, hermes, environmentId } = await makeGate();
  hermes.setRows([ROW('ses_1'), ROW('ses_2')]);
  try {
    await listSessions(gate, '&limit=20');

    const deleted = await fetch(
      `http://127.0.0.1:${gate.port}/v1/sessions/ses_1?backendId=${environmentId}`,
      { method: 'DELETE', headers: auth(gate) },
    );
    assert.equal(deleted.status, 200);

    // Hermes cannot be asked again, and it must not have to be: a session the
    // operator deleted must not come back from the Gate's own rows.
    const held = hermes.hold();
    const after = await listSessions(gate, '&limit=20');
    assert.equal(after.status, 200);
    assert.deepEqual(after.body.data.map((row) => row.id), ['ses_2']);
    assert.equal(hermes.reads().length, 1, 'and the copy, not a second read, is what answered');
    held.release();
  } finally {
    await gate.close();
  }
});

test('a Bot\'s own list is copied under its own key', async () => {
  const { gate, hermes } = await makeGate();
  hermes.setRows([ROW('ses_1')]);
  try {
    const first = await fetch(`http://127.0.0.1:${gate.port}/v1/sessions?bot=atlas&limit=20`, { headers: auth(gate) });
    assert.equal(first.status, 200);
    const second = await fetch(`http://127.0.0.1:${gate.port}/v1/sessions?bot=atlas&limit=20`, { headers: auth(gate) });
    assert.equal(second.status, 200);
    assert.deepEqual((await second.json()).data.map((row) => row.id), ['ses_1']);
    assert.ok(hermes.calls.some((call) => call.forBot === 'atlas'), 'the read was Bot-scoped');

    // The plain environment's copy must not answer a Bot's read, and vice versa.
    const plain = await listSessions(gate, '&limit=20');
    assert.equal(plain.status, 200);
    assert.equal(hermes.reads().length, 2, 'one read per key: the Bot\'s, then the environment\'s');
  } finally {
    await gate.close();
  }
});

test('a kind other than hermes is still read live every time', async () => {
  const { gate, hermes } = await makeGate({ kind: 'opencode', adapterId: 'opencode', environmentId: 'opencode-local' });
  hermes.setRows([ROW('ses_1')]);
  try {
    const first = await listSessions(gate, '&limit=20', 'opencode-local');
    const second = await listSessions(gate, '&limit=20', 'opencode-local');
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.data.map((row) => row.id), ['ses_1']);
    // A copy of a read that costs 0.03 s is a cost with no read saved.
    assert.equal(hermes.reads().length, 2);
    assert.equal(second.body.index, undefined, 'and a live read carries no index verdict');
    assert.equal(hermes.reads()[0].timeoutMs, undefined, 'the screen bound is the backend\'s own, untouched');
  } finally {
    await gate.close();
  }
});

test('a request the copy cannot answer by a window is still read live', async () => {
  const { gate, hermes } = await makeGate();
  hermes.setRows([ROW('ses_1')]);
  try {
    await listSessions(gate, '&limit=20');
    // A cursor is not a page bound: the copy holds one contiguous window, so a
    // request that carries one has to reach the backend to be answered honestly.
    const withCursor = await fetch(
      `http://127.0.0.1:${gate.port}/v1/sessions?backendId=hermes-local&limit=20&before=ses_1`,
      { headers: auth(gate) },
    );
    assert.equal(withCursor.status, 200);
    assert.equal(hermes.reads().length, 2, 'a windowed read must not be served from the copy');
  } finally {
    await gate.close();
  }
});

test('a turn on a session the copy holds keeps what the read measured', async () => {
  const { gate, hermes, environmentId } = await makeGate();
  hermes.setRows([ROW('ses_1', { title: 'Counted', message_count: 12, preview: 'a real preview', started_at: 5 })]);
  try {
    await listSessions(gate, '&limit=20');
    assert.equal(await sendTurn(gate, { backendId: environmentId, sessionId: 'ses_1', messages: [{ role: 'user', content: 'hi' }] }), 200);

    // The turn knew the id, the time, and nothing else. It must not hand the app
    // a row where the title, the counts and the preview a real read measured are
    // gone: a turn that nulls a title reads as Untitled until the next refill.
    const held = hermes.hold();
    const after = await listSessions(gate, '&limit=20');
    const held1 = after.body.data.find((row) => row.id === 'ses_1');
    assert.equal(after.status, 200);
    assert.equal(held1.title, 'Counted');
    assert.equal(held1.message_count, 12);
    assert.equal(held1.preview, 'a real preview');
    assert.equal(held1.started_at, 5);
    assert.equal(typeof held1.last_active, 'number', 'and the field the turn did know is applied');
    held.release();
  } finally {
    await gate.close();
  }
});

test('a load-older read that lands on a running refill still gets the bigger window', async () => {
  // Every window looks a minute old, so the second read answers from the copy
  // AND refills it in the background. The third asks for more rows than that
  // refill is reading, which is exactly the read that used to join it.
  const { gate, hermes, index } = await makeGate({ indexNow: () => Date.now() - 60_000, sessionReadBoundMs: 60 });
  hermes.setRows(Array.from({ length: 30 }, (_, i) => ROW(`ses_${i + 1}`)));
  try {
    await listSessions(gate, '&limit=20');
    const held = hermes.hold();
    const warm = await listSessions(gate, '&limit=20');
    assert.equal(warm.body.index.stale, true);
    assert.equal(hermes.reads().length, 2, 'the copy is refilling in the background');

    const older = await listSessions(gate, '&limit=200');
    assert.equal(older.status, 200);
    assert.equal(older.body.partial, true, '20 rows for a 200 ask is a short page, and must say so');

    // The read behind it was for 20, and 20 cannot answer 200: the backend has to
    // really be asked for the bigger window, or the app concludes from the short
    // page that no Bot Chat is older than this and opens a second one.
    held.release();
    await waitFor(
      async () => (await index.get('hermes-local|'))?.fetchedLimit === 200,
      'the bigger window to be read and kept',
    );
    const later = await listSessions(gate, '&limit=200');
    assert.equal(later.body.data.length, 30);
    assert.equal(later.body.partial, true, 'and the copy is still short of the 200 that was asked for');
  } finally {
    await gate.close();
  }
});

test('the copy is written out on shutdown, not left in the debounce window', async () => {
  const { gate, hermes, gateHome } = await makeGate({ indexWriteDelayMs: 60_000 });
  hermes.setRows([ROW('ses_1')]);
  await listSessions(gate, '&limit=20');
  await gate.close();

  // The refill's write is a minute into the future, so the only thing that can
  // put it on disk before the process is gone is the shutdown itself. A restart
  // that loses it comes back with nothing and re-reads the 3-38 s query the copy
  // existed to avoid.
  const written = await readdir(join(gateHome, 'state', 'session-index'));
  assert.equal(written.length, 1, `expected the window on disk, found ${written.join(', ') || 'nothing'}`);
  assert.match(written[0], /\.json$/);
});

test('a delete lands in the copy after a restart, where nothing is loaded yet', async () => {
  const first = await makeGate();
  first.hermes.setRows([ROW('ses_1'), ROW('ses_2')]);
  try {
    await listSessions(first.gate, '&limit=20');
    await first.index.flush();
  } finally {
    await first.gate.close();
  }

  const second = await makeGate({ reuse: first });
  second.hermes.setRows([ROW('ses_1')]);
  try {
    const deleted = await fetch(
      url(second.gate, `/v1/sessions/ses_2?backendId=${second.environmentId}`),
      { method: 'DELETE', headers: auth(second.gate) },
    );
    assert.equal(deleted.status, 200);

    // The new process has never read this key: the copy is on disk, not in
    // memory. A delete that skipped the load was a no-op, and ses_2 kept showing
    // for as long as the copy lived.
    const held = second.hermes.hold();
    const after = await listSessions(second.gate, '&limit=20');
    assert.deepEqual(after.body.data.map((row) => row.id), ['ses_1']);
    assert.equal(second.hermes.reads().length, 0, 'and the copy, not a second read, is what answered');
    held.release();
  } finally {
    await second.gate.close();
  }
});

test('a turn after a restart keeps the window a read filled', async () => {
  const first = await makeGate({ sessionReadBoundMs: 60 });
  const many = Array.from({ length: 30 }, (_, i) => ROW(`ses_${i + 1}`));
  first.hermes.setRows(many);
  try {
    await listSessions(first.gate, '&limit=200');
    await first.index.flush();
  } finally {
    await first.gate.close();
  }

  const second = await makeGate({ reuse: first, sessionReadBoundMs: 60 });
  second.hermes.setRows(many);
  try {
    assert.equal(
      await sendTurn(second.gate, { backendId: second.environmentId, sessionId: 'ses_1', messages: [{ role: 'user', content: 'hi' }] }),
      200,
    );

    // One turn writes through one row. It must not cost the operator the window a
    // 200-row read had already filled: a write-through that skipped the load
    // replaced it with a one-row copy claiming no window, and this read went
    // back to the slow query it exists to avoid — 60 ms of injected bound here.
    const held = second.hermes.hold();
    const after = await listSessions(second.gate, '&limit=200');
    assert.equal(after.status, 200);
    assert.equal(after.body.data.length, 30);
    assert.equal(after.body.data[0].id, 'ses_1', 'the session the turn touched is the newest row');
    assert.equal(second.hermes.reads().length, 0, 'with no session read at all');
    held.release();
  } finally {
    await second.gate.close();
  }
});

test('an unknown Bot is refused once, on every conversation route', async () => {
  const { gate, hermes } = await makeGate();
  hermes.setRows([ROW('ses_1')]);
  // The refusal has already been written by the time the route learns there is
  // no backend behind it. Carrying on writes a second time over a sent response,
  // which the Gate can only report as ERR_HTTP_HEADERS_SENT.
  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args.map(String).join(' '));
  try {
    for (const [name, response] of [
      ['list', await fetch(url(gate, '/v1/sessions?bot=nobody&limit=20'), { headers: auth(gate) })],
      ['create', await fetch(url(gate, '/v1/sessions'), { method: 'POST', headers: auth(gate), body: JSON.stringify({ bot: 'nobody', title: 'x' }) })],
      ['delete', await fetch(url(gate, '/v1/sessions/ses_1?bot=nobody'), { method: 'DELETE', headers: auth(gate) })],
      ['turn', await fetch(url(gate, '/v1/chat/completions'), { method: 'POST', headers: auth(gate), body: JSON.stringify({ bot: 'nobody', messages: [{ role: 'user', content: 'hi' }] }) })],
    ]) {
      assert.equal(response.status, 404, `${name} answers the Bot refusal`);
      assert.equal((await response.json()).error.code, 'unknown_bot', `${name} names the real reason`);
    }
    assert.deepEqual(
      logged.filter((line) => /HEADERS_SENT|Request handler error/.test(line)),
      [],
      'and nothing tried to answer a second time',
    );
    assert.equal(hermes.calls.filter((call) => 'listSessions' in call).length, 0, 'a refused Bot costs no read');
  } finally {
    console.error = realError;
    await gate.close();
  }
});

// CONN-1. The thread sheet's tap validates a row through `session.restore`
// before switching, and that read asked the environment to LIST its catalogue
// to find one id: 3-38 s against a 6.2 GB `state.db` (2026-10-01), paid on every
// tap, on the same Gate that answers the sheet itself from its own copy in
// microseconds. An environment with a get-by-id read of its own (Hermes) is
// asked directly and is fast; one without it — every CLI environment — has no
// such call, so the copy is the only cheap answer there is.

test('the tap validation is answered from the Gate\'s own copy, not a fresh catalogue read', async () => {
  const { gate, hermes, environmentId } = await makeGate({ listDelayMs: 150 });
  hermes.setRows([ROW('ses_1', { source: 'api_server' })]);
  try {
    // The sheet read that warmed the copy is the only read this Gate makes.
    assert.equal((await listSessions(gate, '&limit=20')).status, 200);
    assert.equal(hermes.reads().length, 1);

    const started = Date.now();
    const restored = await rpc(gate, 'session.restore', { sessionId: 'ses_1', backendId: environmentId });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.result.id, 'ses_1');
    assert.equal(restored.body.result.source, 'api_server');
    assert.equal(
      hermes.reads().length,
      1,
      `the tap must not read the catalogue again, got ${JSON.stringify(hermes.reads())}`,
    );
    assert.ok(Date.now() - started < 100, `the copy answers in microseconds, took ${Date.now() - started}ms`);
  } finally {
    await gate.close();
  }
});

test('a Bot\'s own copy answers the tap validation for that Bot', async () => {
  const { gate, hermes } = await makeGate({ listDelayMs: 150 });
  hermes.setRows([ROW('ses_bot', { source: 'api_server' })]);
  try {
    // The list the sheet reads is Bot-scoped, so the copy is keyed by the Bot.
    const listed = await fetch(url(gate, '/v1/sessions?bot=atlas&limit=20'), { headers: auth(gate) });
    assert.equal(listed.status, 200);
    const readsAfterList = hermes.reads().length;

    const restored = await rpc(gate, 'session.restore', { sessionId: 'ses_bot', bot: 'atlas' });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.result.id, 'ses_bot');
    assert.equal(hermes.reads().length, readsAfterList, 'the Bot\'s own copy answered it');
  } finally {
    await gate.close();
  }
});

test('a row the copy has outlived is still read live, so a deleted session reads as gone', async () => {
  // The copy answers a positive. A MISS may only ever be proved by the host: the
  // copy is refreshed in the background and can be a refill old, so answering a
  // miss from here would retire rows the host still holds — and refuse taps on
  // healthy threads.
  const { gate, hermes, environmentId } = await makeGate();
  hermes.setRows([ROW('ses_1', { source: 'api_server' }), ROW('ses_2', { source: 'api_server' })]);
  try {
    await listSessions(gate, '&limit=20');
    const readsAfterList = hermes.reads().length;

    const missing = await rpc(gate, 'session.restore', { sessionId: 'ses_3', backendId: environmentId });
    assert.equal(missing.body.error.code, 'unknown_session');
    assert.ok(
      hermes.reads().length > readsAfterList,
      'a miss must reach the backend that can prove it',
    );
  } finally {
    await gate.close();
  }
});

test('a copy in a different window never answers this one', async () => {
  const { gate, hermes } = await makeGate();
  hermes.setRows([ROW('ses_1', { source: 'api_server' })]);
  try {
    await listSessions(gate, '&limit=20');
    const readsAfterList = hermes.reads().length;

    // `ses_1` is in the copy under `hermes-local|` — the plain environment's
    // window. The same id under a Bot is a DIFFERENT window, and answering from
    // the environment's copy would be the wrong-scope read this path exists to
    // avoid: the row the operator's sheet shows is not the row that answers.
    const other = await rpc(gate, 'session.restore', { sessionId: 'ses_1', bot: 'atlas' });
    assert.equal(other.status, 200, JSON.stringify(other.body));
    assert.ok(hermes.reads().length > readsAfterList, 'a window that does not hold the id must reach the host');
  } finally {
    await gate.close();
  }
});

// CONN-2. A chat turn writes its session through to the Gate's own copy, so the
// thread shows up at the top of the next list without waiting on the query the
// copy exists to avoid. The row for a session the copy has never read is built
// from a template, and the template claimed the host's own default source —
// `hermes`. The app recognises the threads it owns by `source: 'api_server'`,
// so the planted row read as somebody else's session: a cold start concluded it
// owned no session and resumed the newest OTHER app session it could see, which
// is an unrelated conversation.

test('a row written through by a chat turn is the app\'s own session, not the host\'s', async () => {
  const { gate, hermes, index, environmentId } = await makeGate();
  hermes.setRows([ROW('ses_1', { source: 'api_server' })]);
  try {
    // The list the operator is looking at has warmed a real window, so the
    // window the turn writes into is one the sheet will actually serve.
    await listSessions(gate, '&limit=20');
    const read = ROW('ses_desktop', { source: 'cli', title: 'Started on the desktop' });
    hermes.setRows([ROW('ses_1', { source: 'api_server' }), read]);
    // The copy has no row for it — an id the window never held, which is what
    // eviction, a scope-key mismatch or a failed first read leaves behind.
    await index.get('hermes-local|');

    assert.equal(await sendTurn(gate, {
      backendId: environmentId,
      sessionId: 'ses_desktop',
      messages: [{ role: 'user', content: 'hello' }],
    }), 200);

    const heldRow = (await index.get('hermes-local|')).sessions[0];
    assert.equal(heldRow.id, 'ses_desktop', 'the turn put its session at the top');
    assert.equal(
      heldRow.source,
      'api_server',
      `the app recognises its own threads by source; a row claiming '${heldRow.source}' reads as another surface's session`,
    );
    // Still the row it was: the turn knew the id and the time, nothing else.
    assert.equal(typeof heldRow.last_active, 'number');
  } finally {
    await gate.close();
  }
});

test('a row a live read measured keeps the source that read reported', async () => {
  // The write-through merges field by field, so a session the copy already
  // holds keeps the source Hermes reported for it — this is about a row the
  // copy has never seen, not about overriding what a read proved.
  const { gate, hermes, environmentId } = await makeGate();
  hermes.setRows([ROW('ses_1', { source: 'api_server' })]);
  try {
    await listSessions(gate, '&limit=20');
    assert.equal(await sendTurn(gate, {
      backendId: environmentId,
      sessionId: 'ses_1',
      messages: [{ role: 'user', content: 'hi' }],
    }), 200);

    const held = hermes.hold();
    const after = await listSessions(gate, '&limit=20');
    assert.equal(after.body.data[0].id, 'ses_1');
    assert.equal(after.body.data[0].source, 'api_server', 'the read measured it, so the read still owns it');
    held.release();
  } finally {
    await gate.close();
  }
});
