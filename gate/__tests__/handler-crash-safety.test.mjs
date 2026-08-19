import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';

// A client asking about a session that no longer exists used to take the whole
// Gate down: listMessages threw, the outer catch called writeHead on a response
// whose headers were already sent, and the resulting ERR_HTTP_HEADERS_SENT was
// raised *inside the catch* where nothing handled it. The process exited.
// Observed live -- the phone holds stale session ids after a session is deleted.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const SESSION = {
  id: 'ses_1', source: 'stubcli', user_id: null, model: null, title: 'Stub',
  started_at: 1, ended_at: null, end_reason: null, message_count: 0, tool_call_count: 0,
  input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
  reasoning_tokens: 0, estimated_cost_usd: null, actual_cost_usd: null, api_call_count: 0,
  parent_session_id: null, last_active: 1, preview: null, has_system_prompt: false,
  has_model_config: false,
};

function throwingRegistry() {
  const adapter = {
    adapterId: 'stubcli', adapterRevision: '1', supportedCliVersions: '1.x',
    protocolVersions: { acp: '1' }, capabilities: ['sessions', 'tools', 'models'],
    server: { defaultPort: 1, healthPath: '/', args: () => [], portFromOutput: () => null },
    async probe() { return { state: 'ready', cliVersion: '1.0.0', protocol: 'acp' }; },
    createBackend() {
      return {
        async listSessions() { return [SESSION]; },
        async createSession(input) { return { ...SESSION, title: input?.title ?? null }; },
        async deleteSession() {},
        async listMessages(id) { throw new Error(`session "${id}" not found`); },
        async sendMessage() { throw new Error('backend exploded mid-turn'); },
        async listModels() { return []; },
        async abort() {}, async replyApproval() {},
        // Throws *synchronously*: streamBackendTurn has already written SSE
        // headers by this point, and `.catch()` is never attached, so the
        // error escapes with headers sent -- the exact live crash shape.
        streamEvents() { throw new Error('stream subscribe failed'); },
      };
    },
  };
  return {
    get(id) { if (id !== 'stubcli') throw new Error('unknown adapter'); return adapter; },
    list() { return [adapter]; },
  };
}

async function makeGate() {
  const root = await mkdtemp(join(tmpdir(), 'gate-crash-'));
  roots.push(root);
  const gateHome = join(root, '.gate-home');
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });
  await writeFile(join(gateHome, 'config', 'environments', 'stub-local.json'), JSON.stringify({
    schemaVersion: 1, kind: 'cli-environment', id: 'stub-local', label: 'Stub',
    adapterId: 'stubcli', executable: { path: 'C:\stub.exe' }, protocolPreference: ['acp'],
    versionPolicy: { supported: '1.x', adapterRevision: '1' }, providerRefs: [],
    workspacePolicy: { roots: ['C:\ws'], defaultRoot: 'C:\ws', defaultSandbox: 'workspace_write', allowAdditionalRoots: false },
    lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 1 },
    enabled: true,
  }), 'utf8');

  return createGate({
    root, port: 0, gateHome,
    environmentRegistry: throwingRegistry(),
    backendServerFactory: () => ({
      ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:1', attached: true }),
      stop: async () => {}, isOwned: () => false,
    }),
  });
}

function auth(gate) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` };
}

test('a stale session id is an error response, not a dead Gate', async () => {
  const gate = await makeGate();
  try {
    const response = await fetch(
      `http://127.0.0.1:${gate.port}/v1/sessions/ses_gone/messages?backendId=stub-local`,
      { headers: auth(gate) },
    );
    assert.equal(response.status, 500);
    await response.text();

    // The real regression: the Gate must still be serving afterwards.
    const health = await fetch(`http://127.0.0.1:${gate.port}/health`);
    assert.equal(health.status, 200, 'Gate died handling a stale session id');
  } finally {
    await gate.close();
  }
});

test('the Gate survives a backend that throws mid-turn', async () => {
  const gate = await makeGate();
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ backendId: 'stub-local', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.ok(response.status >= 400, 'a thrown turn must surface as an error status');
    await response.text();

    const health = await fetch(`http://127.0.0.1:${gate.port}/health`);
    assert.equal(health.status, 200, 'Gate died handling a mid-turn backend throw');
  } finally {
    await gate.close();
  }
});

test('repeated stale-session requests never destabilise the Gate', async () => {
  const gate = await makeGate();
  try {
    for (let i = 0; i < 5; i += 1) {
      const response = await fetch(
        `http://127.0.0.1:${gate.port}/v1/sessions/gone_${i}/messages?backendId=stub-local`,
        { headers: auth(gate) },
      );
      await response.text();
    }
    const health = await fetch(`http://127.0.0.1:${gate.port}/health`);
    assert.equal(health.status, 200);
  } finally {
    await gate.close();
  }
});

test('a streaming turn that throws after headers are sent does not kill the Gate', async () => {
  const gate = await makeGate();
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({
        backendId: 'stub-local',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    await response.text().catch(() => '');

    // Without the headersSent guards this request raises
    // ERR_HTTP_HEADERS_SENT inside the outer catch, which is unhandled and
    // exits the process -- so the Gate is gone by the time we ask.
    const health = await fetch(`http://127.0.0.1:${gate.port}/health`);
    assert.equal(health.status, 200, 'Gate died on a post-headers streaming throw');
  } finally {
    await gate.close();
  }
});
