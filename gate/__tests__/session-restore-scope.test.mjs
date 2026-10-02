import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGate } from '../core/server.mjs';

// A thread the operator created in the app is a Hermes session, and tapping its
// row asked the Gate to restore it. The RPC dispatcher resolved the backend
// from `params.backendId` ALONE, and with none it picked "the first attached
// backend that can list sessions" — claude-local, which sorts before
// hermes-local — so the lookup scanned Claude Code's catalogue, found nothing
// and answered `Session not found: <id>` for a session the operator could see
// in the sheet and open in Hermes. `params.bot` was never read at all.

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function session(id, source = 'hermes', extra = {}) {
  return {
    id,
    source,
    user_id: null,
    model: null,
    title: `Session ${id}`,
    started_at: 1,
    ended_at: null,
    end_reason: null,
    message_count: 2,
    tool_call_count: 0,
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    api_call_count: 0,
    parent_session_id: null,
    last_active: 2,
    preview: 'hello',
    has_system_prompt: false,
    has_model_config: false,
    ...extra,
  };
}

/**
 * A Claude-Code-shaped environment: it can list sessions and it can be named,
 * and it holds none of the operator's Hermes threads. `listSessions` records
 * every call so a test can prove the fast path was taken instead.
 */
function claudeLike(calls, { hang = false } = {}) {
  return {
    async listSessions(limit) {
      calls.push(`claude:listSessions:${limit}`);
      if (hang) await new Promise(() => {});
      return [session('cc_1', 'claudecli')];
    },
    async listMessages(id) { calls.push(`claude:listMessages:${id}`); return []; },
    async sendMessage() { return { text: '', message: null }; },
    async listModels() { return []; },
    async abort() {},
    async replyApproval() {},
    async streamEvents() {},
  };
}

/** A Hermes-shaped environment: Bots, and a get-by-id read that answers fast. */
function hermesLike(calls, { sessions = [session('api_1', 'api_server')], getSession, hang = false } = {}) {
  const scoped = (botId) => ({
    kind: 'hermes',
    async getSession(id) {
      calls.push(`hermes:getSession:${botId ?? '-'}:${id}`);
      // A wedged host looks like this from the phone: the call simply never
      // comes back, which is why the sweep is bounded per environment.
      if (hang) await new Promise(() => {});
      if (getSession) return getSession(id, botId);
      const found = sessions.find((entry) => entry.id === id);
      if (found) return found;
      const missing = new Error(`hermes: session ${id} not found`);
      missing.code = 'unknown_session';
      missing.status = 404;
      throw missing;
    },
    async listSessions(limit) {
      calls.push(`hermes:listSessions:${botId ?? '-'}:${limit}`);
      return sessions.slice();
    },
    async listMessages(id) { calls.push(`hermes:listMessages:${botId ?? '-'}:${id}`); return []; },
    async sendMessage() { return { text: '', message: null }; },
    async listModels() { return []; },
    async abort() {},
    async replyApproval() {},
    async streamEvents() {},
  });
  const backend = scoped(undefined);
  return {
    ...backend,
    kind: 'hermes',
    async listBots() { return { object: 'list', data: [{ id: 'default', displayName: 'default', routable: true }] }; },
    async forBot(botId) {
      calls.push(`hermes:forBot:${botId}`);
      if (botId === 'ghost') {
        const error = new Error(`unknown bot "${botId}"`);
        error.code = 'unknown_bot';
        error.status = 404;
        throw error;
      }
      if (botId === 'locked') {
        const error = new Error(`bot "${botId}" has no API_SERVER_KEY`);
        error.code = 'bot_not_routable';
        error.status = 409;
        throw error;
      }
      return scoped(botId);
    },
  };
}

function registryFor(calls, { hermes = {}, claude = {}, slowHermes = false } = {}) {
  const make = (adapterId, capabilities, createBackend) => ({
    adapterId,
    adapterRevision: '1',
    supportedCliVersions: '1.x',
    protocolVersions: { acp: '1' },
    capabilities,
    server: { defaultPort: 1, healthPath: '/', args: () => [], portFromOutput: () => null },
    async probe() { return { state: 'ready', cliVersion: '1.0.0', protocol: 'acp' }; },
    createBackend,
  });
  const claudeAdapter = make('claudecli', ['sessions', 'tools', 'models'], () => claudeLike(calls, claude));
  const hermesAdapter = make('hermescli', ['sessions', 'tools', 'models', 'bots'], () => hermesLike(calls, hermes));
  const adapters = [claudeAdapter, hermesAdapter];
  // A second Hermes-shaped environment whose get-by-id read never returns, so a
  // test can watch the sweep skip it instead of waiting it out.
  if (slowHermes) {
    adapters.push(make('hermescli-slow', ['sessions', 'tools', 'models', 'bots'],
      () => hermesLike(calls, { ...hermes, hang: true })));
  }
  return {
    get(id) {
      const found = adapters.find((adapter) => adapter.adapterId === id);
      if (!found) throw new Error(`unknown CLI adapter "${id}"`);
      return found;
    },
    list() { return adapters; },
  };
}

async function environmentFile(gateHome, id, adapterId) {
  await writeFile(join(gateHome, 'config', 'environments', `${id}.json`), JSON.stringify({
    schemaVersion: 1,
    kind: 'cli-environment',
    id,
    label: id,
    adapterId,
    executable: { path: 'C:\\stub.exe' },
    protocolPreference: ['acp'],
    versionPolicy: { supported: '1.x', adapterRevision: '1' },
    providerRefs: [],
    workspacePolicy: { roots: ['C:\\ws'], defaultRoot: 'C:\\ws', defaultSandbox: 'workspace_write', allowAdditionalRoots: false },
    lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 1 },
    enabled: true,
  }), 'utf8');
}

/**
 * "aaa-plain" sorts first on purpose: it is the environment the scope-less
 * dispatcher always picked, and the one that cannot hold the session.
 */
async function makeGate({ calls = [], backends = {}, gateOptions = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gate-restore-'));
  roots.push(root);
  const gateHome = join(root, '.gate-home');
  await mkdir(join(root, 'registry'), { recursive: true });
  await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });
  await environmentFile(gateHome, 'aaa-plain', 'claudecli');
  await environmentFile(gateHome, 'zzz-hermes', 'hermescli');
  if (backends.slowHermes) await environmentFile(gateHome, 'zzz-hermes-slow', 'hermescli-slow');
  const gate = await createGate({
    root,
    port: 0,
    gateHome,
    environmentRegistry: registryFor(calls, backends),
    backendServerFactory: () => ({
      ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:1', attached: true }),
      stop: async () => {},
      isOwned: () => false,
    }),
    ...gateOptions,
  });
  const rpc = async (method, params = {}) => {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ method, params }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { gate, calls, rpc };
}

test('a scope-less session.restore finds the session Hermes holds, not Claude Code\'s catalogue', async () => {
  const { gate, rpc, calls } = await makeGate();
  try {
    const restored = await rpc('session.restore', { sessionId: 'api_1' });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.result.id, 'api_1');
    assert.ok(
      calls.includes('hermes:getSession:-:api_1'),
      `the Hermes get-by-id read should answer, got ${JSON.stringify(calls)}`,
    );
  } finally {
    await gate.close();
  }
});

test('the lookup asks the session\'s own environment for the id alone', async () => {
  // Hermes answers GET /api/sessions/{id} in ~0.1 s; listing 200 rows to find
  // one id took 3-4 s warm and 30 s+ cold, and called a session outside the
  // newest page "not found". An environment with no get-by-id read still falls
  // back to the list scan — that fallback is not what went wrong here.
  const { gate, rpc, calls } = await makeGate();
  try {
    assert.equal((await rpc('session.restore', { sessionId: 'api_1' })).status, 200);
    assert.ok(calls.includes('hermes:getSession:-:api_1'), JSON.stringify(calls));
    assert.deepEqual(calls.filter((call) => call.startsWith('hermes:listSessions')), []);
  } finally {
    await gate.close();
  }
});

test('a scope-less restore reaches the Bot-scoped environment the index last listed the id from', async () => {
  const calls = [];
  const { gate, rpc } = await makeGate({ calls });
  try {
    // The Gate's own copy holds the id under a Bot key, which is what the
    // sessions sheet listed a moment ago.
    const listed = await fetch(`http://127.0.0.1:${gate.port}/v1/sessions?bot=default`, {
      headers: { Authorization: `Bearer ${gate.token}` },
    });
    assert.equal(listed.status, 200);
    calls.length = 0;

    const restored = await rpc('session.restore', { sessionId: 'api_1' });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.ok(
      calls.includes('hermes:getSession:default:api_1'),
      `the indexed Bot scope should answer first, got ${JSON.stringify(calls)}`,
    );
  } finally {
    await gate.close();
  }
});

test('an environment that cannot answer does not hold up the ones that can', async () => {
  // The sweep is bounded per environment: Claude Code here never returns, and
  // Hermes still has the session. Before the bound the tap simply hung.
  const { gate, rpc } = await makeGate({ gateOptions: { sessionLookupBoundMs: 40 }, backends: { claude: { hang: true } } });
  try {
    const restored = await rpc('session.restore', { sessionId: 'api_1' });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.result.id, 'api_1');
  } finally {
    await gate.close();
  }
});

test('a get-by-id read that never returns is bounded like any other candidate', async () => {
  // The fast path is `GET /api/sessions/{id}` — which is exactly the call a
  // wedged `state.db` never answers. So the bound has to cover the candidate
  // that has one, not just the ones that fall back to listing the catalogue:
  // here a second Hermes-shaped environment hangs on that read and must count
  // as "not here" while the one that can answer wins.
  const { gate, rpc } = await makeGate({
    gateOptions: { sessionLookupBoundMs: 40 },
    backends: { slowHermes: true },
  });
  try {
    const restored = await rpc('session.restore', { sessionId: 'api_1' });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.result.id, 'api_1');
  } finally {
    await gate.close();
  }
});

test('a named environment is read there and nowhere else', async () => {
  const calls = [];
  const { gate, rpc } = await makeGate({ calls });
  try {
    const restored = await rpc('session.restore', { sessionId: 'api_1', backendId: 'zzz-hermes' });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.ok(!calls.some((call) => call.startsWith('claude:')), `claude must not be asked: ${JSON.stringify(calls)}`);
  } finally {
    await gate.close();
  }
});

test('a named Bot names its environment, and an unroutable one is refused by name', async () => {
  const calls = [];
  const { gate, rpc } = await makeGate({ calls });
  try {
    const restored = await rpc('session.restore', { sessionId: 'api_1', bot: 'default' });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.ok(calls.includes('hermes:getSession:default:api_1'), JSON.stringify(calls));
    // A scope that names an environment pins it, so a Bot travels with it.
    calls.length = 0;
    const pinned = await rpc('session.restore', { sessionId: 'api_1', bot: 'default', backendId: 'zzz-hermes' });
    assert.equal(pinned.status, 200, JSON.stringify(pinned.body));

    // The refusals the REST routes already gave, now on the RPC envelope.
    const unknown = await rpc('session.restore', { sessionId: 'api_1', bot: 'ghost' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'unknown_bot');

    const locked = await rpc('session.restore', { sessionId: 'api_1', bot: 'locked' });
    assert.equal(locked.status, 409);
    assert.equal(locked.body.error.code, 'bot_not_routable');
  } finally {
    await gate.close();
  }
});

test('an id nobody holds fails by name, so the app can tell a miss from a slow host', async () => {
  const { gate, rpc } = await makeGate();
  try {
    const missing = await rpc('session.restore', { sessionId: 'api_nope', backendId: 'zzz-hermes' });
    assert.equal(missing.body.error.code, 'unknown_session');
    assert.equal(missing.body.error.message, 'Session not found: api_nope');

    // Unscoped, after both environments have been asked and neither had it.
    const swept = await rpc('session.restore', { sessionId: 'api_nope' });
    assert.equal(swept.body.error.code, 'unknown_session');
    assert.equal(swept.body.error.message, 'Session not found: api_nope');
  } finally {
    await gate.close();
  }
});

test('a host that fails is NOT reported as a missing session', async () => {
  // The app refuses a tap on `unknown_session` alone, so turning a slow or
  // broken environment into that word would make the Gate delete rows.
  const { gate, rpc } = await makeGate({
    backends: { hermes: { getSession: () => { throw Object.assign(new Error('hermes: state.db is locked'), { status: 503 }); } } },
  });
  try {
    const broken = await rpc('session.restore', { sessionId: 'api_1', backendId: 'zzz-hermes' });
    assert.notEqual(broken.body.error.code, 'unknown_session');
    assert.match(broken.body.error.message, /state\.db is locked/);
  } finally {
    await gate.close();
  }
});

test('a confirmed miss retires the row, so the next list stops offering it', async () => {
  // The Gate keeps its own copy of a Hermes list, keyed by environment and Bot.
  // A session that disappeared upstream is still in that copy, so the next list
  // would keep offering a row that cannot be opened — unless the miss that just
  // proved it retires the row there too.
  const live = [session('api_1', 'api_server'), session('api_2', 'api_server')];
  const { gate, rpc } = await makeGate({ backends: { hermes: { sessions: live } } });
  const list = async () => {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/sessions?bot=default`, {
      headers: { Authorization: `Bearer ${gate.token}` },
    });
    const body = await response.json();
    return body.data.map((entry) => entry.id);
  };
  try {
    assert.deepEqual((await list()).sort(), ['api_1', 'api_2']);

    // Gone upstream between the list and the tap.
    live.splice(live.indexOf(live.find((entry) => entry.id === 'api_2')), 1);
    const gone = await rpc('session.restore', { sessionId: 'api_2', backendId: 'zzz-hermes', bot: 'default' });
    assert.equal(gone.body.error.code, 'unknown_session');

    assert.deepEqual((await list()).sort(), ['api_1']);
  } finally {
    await gate.close();
  }
});

test('a confirmed miss scoped by Bot alone retires the row too', async () => {
  // A Bot names its own environment, so the app sends the Bot and no
  // environment — which is exactly how the operator's `default`-Bot thread is
  // tapped. The index is keyed by the environment the list was read from, so a
  // retirement keyed on the raw params would look under `|default`, a window
  // nothing was ever written to, and the stale row would survive the miss.
  const live = [session('api_1', 'api_server'), session('api_2', 'api_server')];
  const { gate, rpc } = await makeGate({ backends: { hermes: { sessions: live } } });
  const list = async () => {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/sessions?bot=default`, {
      headers: { Authorization: `Bearer ${gate.token}` },
    });
    const body = await response.json();
    return body.data.map((entry) => entry.id);
  };
  try {
    assert.deepEqual((await list()).sort(), ['api_1', 'api_2']);

    live.splice(live.indexOf(live.find((entry) => entry.id === 'api_2')), 1);
    const gone = await rpc('session.restore', { sessionId: 'api_2', bot: 'default' });
    assert.equal(gone.body.error.code, 'unknown_session');

    assert.deepEqual((await list()).sort(), ['api_1']);
  } finally {
    await gate.close();
  }
});

test('a host that fails retires nothing: only a proved miss may drop a row', async () => {
  // The scoped read above retires the row because the host said `404`. A host
  // that merely failed has not claimed the session is gone, and dropping the
  // row on its word would empty the sessions sheet every time the environment
  // hiccups. The scope-less path reads the same index key, so it must judge the
  // same way.
  const live = [session('api_1', 'api_server'), session('api_2', 'api_server')];
  const { gate, rpc } = await makeGate({
    backends: {
      hermes: {
        sessions: live,
        getSession: (id, botId) => {
          if (botId) throw Object.assign(new Error('hermes: state.db is locked'), { status: 503 });
          const found = live.find((entry) => entry.id === id);
          if (found) return found;
          const missing = new Error(`hermes: session ${id} not found`);
          missing.code = 'unknown_session';
          throw missing;
        },
      },
    },
  });
  const list = async () => {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/sessions?bot=default`, {
      headers: { Authorization: `Bearer ${gate.token}` },
    });
    const body = await response.json();
    return body.data.map((entry) => entry.id);
  };
  try {
    assert.deepEqual((await list()).sort(), ['api_1', 'api_2']);

    // The Bot-scoped read fails; the sweep still finds the session unscoped.
    const restored = await rpc('session.restore', { sessionId: 'api_2' });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.result.id, 'api_2');

    assert.deepEqual((await list()).sort(), ['api_1', 'api_2']);
  } finally {
    await gate.close();
  }
});
