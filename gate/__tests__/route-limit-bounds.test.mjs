import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';

// `limit` on the session and message reads used to be read as
// `Number(value) || undefined`: a negative number is truthy, so it reached
// `Array.prototype.slice`, where `-5` means "all but the last five" and, on a
// message page, pushed the lower bound past the upper one and produced an
// empty page. `NaN` fell back to `undefined` and quietly meant "the whole
// list". Both answered 200, so a malformed request looked exactly like a
// truthful answer. These tests pin the honest rule: absent or empty means the
// whole list, a positive whole number is honoured, and anything else is a 400
// with a code, before any Bot or backend is resolved.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Five sessions, newest first, as a backend lists them. */
const SESSIONS = ['ses_5', 'ses_4', 'ses_3', 'ses_2', 'ses_1'].map((id, index) => ({
  id,
  source: 'stubcli',
  user_id: null,
  model: null,
  title: `Session ${5 - index}`,
  started_at: 5 - index,
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
  last_active: 5 - index,
  preview: null,
  has_system_prompt: false,
  has_model_config: false,
}));

/** 25 turns, oldest first, ids m1..m25. */
const ALL_MESSAGES = Array.from({ length: 25 }, (_, i) => ({
  id: `m${i + 1}`,
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: [{ type: 'text', text: `turn ${i + 1}` }],
  timestamp: i + 1,
}));

function limitRegistry(calls) {
  const backend = {
    adapterId: 'stubcli',
    adapterRevision: '1',
    supportedCliVersions: '1.x',
    protocolVersions: { acp: '1' },
    capabilities: ['sessions', 'tools', 'models'],
    server: { defaultPort: 1, healthPath: '/', args: () => [], portFromOutput: () => null },
    async probe() { return { state: 'ready', cliVersion: '1.0.0', protocol: 'acp' }; },
    createBackend() {
      const forBot = (botId) => ({
        async listSessions(limit) {
          calls.push(`listSessions:${botId}:${limit ?? 'all'}`);
          return SESSIONS;
        },
        async listMessages(id, limit) {
          calls.push(`listMessages:${botId}:${id}:${limit ?? 'all'}`);
          return ALL_MESSAGES;
        },
      });
      return {
        forBot,
        async listSessions(limit) {
          calls.push(`listSessions:${limit ?? 'all'}`);
          return SESSIONS;
        },
        async createSession(input) { return { ...SESSIONS[0], title: input?.title ?? null }; },
        async deleteSession() {},
        async listMessages(id, limit) {
          calls.push(`listMessages:${id}:${limit ?? 'all'}`);
          return ALL_MESSAGES;
        },
        async sendMessage() { return { text: '', message: null }; },
        async listModels() { return []; },
        async abort() {},
        async replyApproval() {},
        async streamEvents() {},
      };
    },
  };
  return {
    get(id) { if (id !== 'stubcli') throw new Error(`unknown CLI adapter "${id}"`); return backend; },
    list() { return [backend]; },
  };
}

async function makeGate({ calls = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gate-limit-bounds-'));
  roots.push(root);
  const gateHome = join(root, '.gate-home');
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });
  await writeFile(join(gateHome, 'config', 'environments', 'stub-local.json'), JSON.stringify({
    schemaVersion: 1, kind: 'cli-environment', id: 'stub-local', label: 'Stub CLI',
    adapterId: 'stubcli', executable: { path: 'C:\\stub.exe' }, protocolPreference: ['acp'],
    versionPolicy: { supported: '1.x', adapterRevision: '1' }, providerRefs: [],
    workspacePolicy: { roots: ['C:\\ws'], defaultRoot: 'C:\\ws', defaultSandbox: 'workspace_write', allowAdditionalRoots: false },
    lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 1 },
    enabled: true,
  }), 'utf8');

  const gate = await createGate({
    root,
    port: 0,
    gateHome,
    environmentRegistry: limitRegistry(calls),
    backendServerFactory: () => ({
      ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:1', attached: true }),
      stop: async () => {},
      isOwned: () => false,
    }),
  });
  return { gate, calls };
}

function auth(gate) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` };
}

function sessionsUrl(gate, query = '') {
  return `http://127.0.0.1:${gate.port}/v1/sessions?backendId=stub-local${query ? `&${query}` : ''}`;
}

function messagesUrl(gate, query = '') {
  return `http://127.0.0.1:${gate.port}/v1/sessions/ses_1/messages?backendId=stub-local${query ? `&${query}` : ''}`;
}

async function refusal(response) {
  assert.equal(response.status, 400, 'a malformed limit is a client error, not a slice');
  const body = await response.json();
  assert.equal(body.error.code, 'invalid_limit');
  assert.match(body.error.message, /limit/);
  return body;
}

test('a negative session limit is refused instead of slicing the tail off the list', async () => {
  const { gate, calls } = await makeGate();
  try {
    // Before the fix this answered 200 with every session but the newest five.
    const response = await fetch(sessionsUrl(gate, 'limit=-5'), { headers: auth(gate) });
    await refusal(response);
    assert.deepEqual(calls, [], 'a refused request must not reach the backend');
  } finally {
    await gate.close();
  }
});

test('a non-numeric session limit is refused instead of meaning "the whole list"', async () => {
  const { gate, calls } = await makeGate();
  try {
    const response = await fetch(sessionsUrl(gate, 'limit=abc'), { headers: auth(gate) });
    await refusal(response);
    assert.deepEqual(calls, []);
  } finally {
    await gate.close();
  }
});

test('zero and fractional session limits are refused instead of guessed at', async () => {
  const { gate } = await makeGate();
  try {
    for (const raw of ['0', '1.5', '-0', 'Infinity']) {
      const response = await fetch(sessionsUrl(gate, `limit=${encodeURIComponent(raw)}`), { headers: auth(gate) });
      await refusal(response);
    }
  } finally {
    await gate.close();
  }
});

test('a negative message limit is refused instead of answering an empty page', async () => {
  // Before the fix `Math.max(0, upper - (-10))` put the lower bound past the
  // upper one: the page was empty and hasMore was true, forever.
  const { gate, calls } = await makeGate();
  try {
    const response = await fetch(messagesUrl(gate, 'limit=-10'), { headers: auth(gate) });
    await refusal(response);
    assert.deepEqual(calls, [], 'a refused request must not read the transcript');
  } finally {
    await gate.close();
  }
});

test('a non-numeric message limit is refused instead of returning the whole history', async () => {
  const { gate, calls } = await makeGate();
  try {
    const response = await fetch(messagesUrl(gate, 'limit=ten'), { headers: auth(gate) });
    await refusal(response);
    assert.deepEqual(calls, []);
  } finally {
    await gate.close();
  }
});

test('a valid session limit still answers the same rows as before', async () => {
  const { gate, calls } = await makeGate();
  try {
    const response = await fetch(sessionsUrl(gate, 'limit=2'), { headers: auth(gate) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.object, 'list');
    assert.deepEqual(body.data.map((session) => session.id), ['ses_5', 'ses_4']);
    assert.deepEqual(calls, ['listSessions:2'], 'the limit still travels to the backend');
  } finally {
    await gate.close();
  }
});

test('a valid message limit still pages back from the newest turn', async () => {
  const { gate } = await makeGate();
  try {
    const response = await fetch(messagesUrl(gate, 'limit=10'), { headers: auth(gate) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.length, 10);
    assert.equal(body.data.at(-1).id, 'm25');
    assert.equal(body.data[0].id, 'm16');
    assert.equal(body.hasMore, true);
    assert.equal(body.nextBefore, 'm16');

    const walked = await fetch(messagesUrl(gate, 'limit=10&before=m16'), { headers: auth(gate) });
    assert.equal(walked.status, 200);
    const older = await walked.json();
    assert.deepEqual(older.data.map((message) => message.id), ALL_MESSAGES.slice(5, 15).map((message) => message.id));
    assert.equal(older.hasMore, true);
    assert.equal(older.nextBefore, 'm6');
  } finally {
    await gate.close();
  }
});

test('an absent or empty limit still returns everything with no cursor', async () => {
  const { gate } = await makeGate();
  try {
    for (const query of ['', 'limit=']) {
      const sessions = await fetch(sessionsUrl(gate, query), { headers: auth(gate) });
      assert.equal(sessions.status, 200);
      const list = await sessions.json();
      assert.deepEqual(list.data.map((session) => session.id), SESSIONS.map((session) => session.id));

      const messages = await fetch(messagesUrl(gate, query), { headers: auth(gate) });
      assert.equal(messages.status, 200);
      const page = await messages.json();
      assert.equal(page.data.length, ALL_MESSAGES.length);
      assert.equal(page.hasMore, false);
      assert.equal(page.nextBefore, null);
    }
  } finally {
    await gate.close();
  }
});
