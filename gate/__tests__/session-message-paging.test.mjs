import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';

// Paging lives in the Gate rather than the backends: all three CLI backends
// read their whole transcript upstream and cannot ask for a slice. These tests
// pin the client-facing contract -- a bounded, stable page and a cursor that
// walks backwards without ever re-serving the newest page.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const SESSION = {
  id: 'ses_1', source: 'stubcli', user_id: null, model: null, title: 'Stub session',
  started_at: 1, ended_at: null, end_reason: null, message_count: 0, tool_call_count: 0,
  input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
  reasoning_tokens: 0, estimated_cost_usd: null, actual_cost_usd: null, api_call_count: 0,
  parent_session_id: null, last_active: 1, preview: null, has_system_prompt: false,
  has_model_config: false,
};

/** 25 turns, oldest first, ids m1..m25. */
const ALL_MESSAGES = Array.from({ length: 25 }, (_, i) => ({
  id: `m${i + 1}`,
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: [{ type: 'text', text: `turn ${i + 1}` }],
  timestamp: i + 1,
}));

function pagingRegistry(calls) {
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
        async listMessages(id, limit) {
          calls.push(`listMessages:${id}:${limit}`);
          return typeof limit === 'number' ? ALL_MESSAGES.slice(-limit) : ALL_MESSAGES;
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
    get(id) { if (id !== 'stubcli') throw new Error(`unknown CLI adapter "${id}"`); return adapter; },
    list() { return [adapter]; },
  };
}

async function makeGate({ calls = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gate-paging-'));
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
    environmentRegistry: pagingRegistry(calls),
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

function messagesUrl(gate, query) {
  return `http://127.0.0.1:${gate.port}/v1/sessions/ses_1/messages?backendId=stub-local&${query}`;
}

test('a first page returns the newest turns and a cursor to walk back from', async () => {
  const { gate } = await makeGate();
  try {
    const body = await (await fetch(messagesUrl(gate, 'limit=10'), { headers: auth(gate) })).json();

    assert.equal(body.data.length, 10);
    assert.equal(body.data.at(-1).id, 'm25', 'the page must end at the newest turn');
    assert.equal(body.data[0].id, 'm16');
    assert.equal(body.hasMore, true);
    assert.equal(body.nextBefore, 'm16', 'the cursor is the oldest id on this page');
  } finally {
    await gate.close();
  }
});

test('the cursor walks strictly backwards without overlap', async () => {
  const { gate } = await makeGate();
  try {
    const first = await (await fetch(messagesUrl(gate, 'limit=10'), { headers: auth(gate) })).json();
    const second = await (
      await fetch(messagesUrl(gate, `limit=10&before=${first.nextBefore}`), { headers: auth(gate) })
    ).json();

    assert.equal(second.data.at(-1).id, 'm15', 'must resume immediately before the cursor');
    assert.equal(second.data[0].id, 'm6');
    assert.equal(second.hasMore, true);

    const overlap = second.data.filter((m) => first.data.some((f) => f.id === m.id));
    assert.deepEqual(overlap, [], 'pages must not repeat turns');
  } finally {
    await gate.close();
  }
});

test('the final page reports no more history', async () => {
  const { gate } = await makeGate();
  try {
    let body = await (await fetch(messagesUrl(gate, 'limit=10'), { headers: auth(gate) })).json();
    body = await (await fetch(messagesUrl(gate, `limit=10&before=${body.nextBefore}`), { headers: auth(gate) })).json();
    body = await (await fetch(messagesUrl(gate, `limit=10&before=${body.nextBefore}`), { headers: auth(gate) })).json();

    assert.equal(body.data.length, 5, 'the beginning of the session is a short page');
    assert.equal(body.data[0].id, 'm1');
    assert.equal(body.hasMore, false);
    assert.equal(body.nextBefore, null);
  } finally {
    await gate.close();
  }
});

test('an unknown cursor is rejected rather than silently re-serving the newest page', async () => {
  const { gate } = await makeGate();
  try {
    const response = await fetch(messagesUrl(gate, 'limit=10&before=nope'), { headers: auth(gate) });
    // Treating an unknown cursor as "no cursor" would hand back the newest page
    // forever, and a client paging backwards would never terminate.
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /unknown cursor/);
  } finally {
    await gate.close();
  }
});

test('no limit returns the whole history with no cursor', async () => {
  const { gate } = await makeGate();
  try {
    const body = await (await fetch(messagesUrl(gate, 'x=1'), { headers: auth(gate) })).json();

    assert.equal(body.data.length, ALL_MESSAGES.length);
    assert.equal(body.hasMore, false);
    assert.equal(body.nextBefore, null);
  } finally {
    await gate.close();
  }
});
