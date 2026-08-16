import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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

/** An adapter whose "native server" is entirely in-process. */
function stubRegistry(calls) {
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
        async listSessions() { calls.push('listSessions'); return [SESSION]; },
        async createSession(input) { calls.push('createSession'); return { ...SESSION, title: input?.title ?? null }; },
        async deleteSession(id) { calls.push(`deleteSession:${id}`); },
        async listMessages(id, limit) { calls.push(`listMessages:${id}:${limit}`); return [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 }]; },
        async sendMessage(id, { text }) { calls.push(`sendMessage:${id}`); return { text: `echo ${text}`, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: `echo ${text}` }] } }; },
        async listModels() { calls.push('listModels'); return [{ id: 'stub/one', providerId: 'stub', modelId: 'one', label: 'Stub One', available: true }]; },
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
  const root = await mkdtemp(join(tmpdir(), 'gate-backend-'));
  roots.push(root);
  const gateHome = join(root, '.gate-home');
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });
  await writeFile(join(gateHome, 'config', 'environments', 'stub-local.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'cli-environment',
    id: 'stub-local',
    label: 'Stub CLI',
    adapterId: 'stubcli',
    executable: { path: 'C:\\stub.exe' },
    protocolPreference: ['acp'],
    versionPolicy: { supported: '1.x', adapterRevision: '1' },
    providerRefs: [],
    workspacePolicy: { roots: ['C:\\ws'], defaultRoot: 'C:\\ws', defaultSandbox: 'workspace_write', allowAdditionalRoots: false },
    lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 1 },
    enabled: true,
  }), 'utf8');

  const gate = await createGate({
    root,
    port: 0,
    gateHome,
    environmentRegistry: stubRegistry(calls),
    // The stub server needs no process: report it as already reachable.
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

test('the manifest advertises sessions only because a backend provides them', async () => {
  const { gate } = await makeGate();
  try {
    const manifest = await (await fetch(`http://127.0.0.1:${gate.port}/.well-known/gateway.json`)).json();
    assert.equal(manifest.capabilities.sessions, true);
    assert.equal(manifest.capabilities.tools, true);
    assert.equal(manifest.endpoints.sessions, '/v1/sessions');
    assert.ok(manifest.endpoints.sessionMessages, 'sessionMessages endpoint must be advertised');
    assert.equal(manifest.backends?.[0]?.id, 'stub-local');
    assert.equal(manifest.backends?.[0]?.kind, 'environment');
  } finally {
    await gate.close();
  }
});

test('sessions are listed from the backend', async () => {
  const { gate, calls } = await makeGate();
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/sessions?backendId=stub-local`, { headers: auth(gate) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data[0].id, 'ses_1');
    assert.ok(calls.includes('listSessions'));
  } finally {
    await gate.close();
  }
});

test('a session can be created and deleted through the Gate', async () => {
  const { gate, calls } = await makeGate();
  try {
    const created = await (await fetch(`http://127.0.0.1:${gate.port}/v1/sessions`, {
      method: 'POST', headers: auth(gate), body: JSON.stringify({ backendId: 'stub-local', title: 'From phone' }),
    })).json();
    assert.equal(created.title, 'From phone');

    const deleted = await fetch(`http://127.0.0.1:${gate.port}/v1/sessions/ses_1?backendId=stub-local`, {
      method: 'DELETE', headers: auth(gate),
    });
    assert.equal(deleted.status, 200);
    assert.ok(calls.includes('deleteSession:ses_1'));
  } finally {
    await gate.close();
  }
});

test('session messages come back in the shape the app parses', async () => {
  const { gate } = await makeGate();
  try {
    const body = await (await fetch(
      `http://127.0.0.1:${gate.port}/v1/sessions/ses_1/messages?backendId=stub-local&limit=20`,
      { headers: auth(gate) },
    )).json();
    assert.equal(body.data[0].role, 'user');
    assert.deepEqual(body.data[0].content, [{ type: 'text', text: 'hi' }]);
  } finally {
    await gate.close();
  }
});

test('chat routed to a backend goes through the CLI, not the provider proxy', async () => {
  const { gate, calls } = await makeGate();
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST', headers: auth(gate),
      body: JSON.stringify({ backendId: 'stub-local', sessionId: 'ses_1', messages: [{ role: 'user', content: 'ping' }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'echo ping');
    assert.ok(calls.some((c) => c.startsWith('sendMessage:')));
  } finally {
    await gate.close();
  }
});

test('backend models are advertised alongside provider models', async () => {
  const { gate } = await makeGate();
  try {
    const body = await (await fetch(`http://127.0.0.1:${gate.port}/v1/models`, { headers: auth(gate) })).json();
    const stub = body.data.find((m) => m.id === 'stub/one');
    assert.ok(stub, 'the backend catalog should appear in /v1/models');
    assert.equal(stub.backendId, 'stub-local');
  } finally {
    await gate.close();
  }
});

test('a stdio adapter is supervised by the stdio server, not the HTTP one', async () => {
  const { createBackendManager } = await import('../core/cli-environments/backend-manager.mjs');
  const chosen = [];
  const manager = createBackendManager({
    store: { async get() { return { id: 'e', enabled: true, adapterId: 'x', workspacePolicy: {} }; }, async list() { return []; } },
    registry: {
      get() {
        return {
          adapterId: 'x',
          server: { transport: 'stdio', args: () => [] },
          createBackend: ({ rpc }) => ({ rpc }),
        };
      },
    },
  });
  // Without a transport-aware default this used the HTTP supervisor and timed
  // out waiting for a port that a stdio server never opens.
  await manager.get('e').catch((error) => chosen.push(error.message));
  assert.ok(
    !chosen.some((m) => /did not become reachable/i.test(m)),
    `stdio backend must not be polled for an HTTP port (got: ${chosen.join('; ')})`,
  );
});

test('an unknown backend is refused with a named error', async () => {
  const { gate } = await makeGate();
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/sessions?backendId=nope`, { headers: auth(gate) });
    assert.equal(response.status, 404);
    assert.match((await response.json()).error.message, /not found|cannot act/i);
  } finally {
    await gate.close();
  }
});

test('session routes require authentication', async () => {
  const { gate } = await makeGate();
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/sessions?backendId=stub-local`);
    assert.equal(response.status, 401);
  } finally {
    await gate.close();
  }
});

test('a live probe reaches the backend picker as real health, not the static capability list', async () => {
  const { gate } = await makeGate();
  try {
    // Before any probe, the environment is enabled but unchecked.
    const before = await (await fetch(`http://127.0.0.1:${gate.port}/v1/backends`, { headers: auth(gate) })).json();
    assert.equal(before.backends[0].state, 'stopped');
    assert.equal(before.backends[0].cliVersion, undefined);

    const checked = await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ method: 'environments.check', params: { id: 'stub-local' } }),
    });
    assert.equal(checked.status, 200);

    const after = await (await fetch(`http://127.0.0.1:${gate.port}/v1/backends`, { headers: auth(gate) })).json();
    assert.equal(after.backends[0].state, 'ready');
    assert.equal(after.backends[0].cliVersion, '1.0.0');
  } finally {
    await gate.close();
  }
});
