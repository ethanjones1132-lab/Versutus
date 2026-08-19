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

/**
 * An adapter whose turn behaviour (sendMessage/streamEvents) is fully test-
 * controlled — used to drive the Gate's own empty-turn detection rather than
 * a fixed canned reply.
 */
function stubTurnRegistry({ calls = [], sendMessage, streamEvents } = {}) {
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
        async sendMessage(id, input) { calls.push('sendMessage'); return sendMessage(id, input); },
        async listModels() { return []; },
        async abort() {},
        async replyApproval() {},
        async streamEvents(id, onEvent, signal) {
          calls.push('streamEvents');
          if (streamEvents) return streamEvents(id, onEvent, signal);
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

async function makeGate({ calls = [], provider, registry } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gate-backend-'));
  roots.push(root);
  const gateHome = join(root, '.gate-home');
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  if (provider) {
    await writeFile(join(root, 'registry', `${provider.id}.json`), JSON.stringify({
      kind: 'provider',
      label: provider.label ?? provider.id,
      config: {
        flavor: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKeyEnv: 'TEST_KEY',
        models: provider.models ?? [],
        streaming: true,
      },
    }), 'utf8');
  }
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
    environmentRegistry: registry ?? stubRegistry(calls),
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

// ─── empty-turn detection ───────────────────────────────────────────
// Reproduced live 2026-08-16: opencode-local's default model 404s upstream,
// the turn "completes" with zero content, and the app rendered an empty
// bubble with HTTP 200 and a clean [DONE]. A turn the backend reports as
// finished but that produced nothing visible must fail loudly instead.

test('a streamed turn with no content surfaces an error instead of a silent [DONE]', async () => {
  const registry = stubTurnRegistry({
    sendMessage: async () => ({ text: '', message: { role: 'assistant', content: [] } }),
  });
  const { gate } = await makeGate({ registry });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST', headers: auth(gate),
      body: JSON.stringify({
        backendId: 'stub-local', sessionId: 'ses_1',
        messages: [{ role: 'user', content: 'say exactly: ping ok' }],
        stream: true,
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"code":"empty_turn"/);
    assert.match(text, /\[DONE\]/);
  } finally {
    await gate.close();
  }
});

test('a tool-only turn is not flagged as empty', async () => {
  const registry = stubTurnRegistry({
    sendMessage: async () => ({
      text: '',
      message: { role: 'assistant', content: [], tool_calls: [{ name: 'read', id: 'c1', status: 'complete' }] },
    }),
    streamEvents: async (id, onEvent, signal) => {
      onEvent({ type: 'tool.started', payload: { name: 'read', callId: 'c1' } });
      await new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', resolve, { once: true });
      });
    },
  });
  const { gate } = await makeGate({ registry });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST', headers: auth(gate),
      body: JSON.stringify({
        backendId: 'stub-local', sessionId: 'ses_1',
        messages: [{ role: 'user', content: 'read the file' }],
        stream: true,
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(text, /empty_turn/);
    assert.match(text, /"name":"read"/);
    assert.match(text, /\[DONE\]/);
  } finally {
    await gate.close();
  }
});

test('a non-streaming turn with no content fails instead of returning a fake success', async () => {
  const registry = stubTurnRegistry({
    sendMessage: async () => ({ text: '', message: { role: 'assistant', content: [] } }),
  });
  const { gate } = await makeGate({ registry });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST', headers: auth(gate),
      body: JSON.stringify({
        backendId: 'stub-local', sessionId: 'ses_1',
        messages: [{ role: 'user', content: 'say exactly: ping ok' }],
      }),
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error.code, 'empty_turn');
  } finally {
    await gate.close();
  }
});

test('a client that disconnects mid-turn does not get an empty-turn error and does not crash the Gate', async () => {
  let resolveSend;
  let onInFlight;
  const inFlight = new Promise((resolve) => { onInFlight = resolve; });
  const registry = stubTurnRegistry({
    sendMessage: () =>
      new Promise((resolve) => {
        resolveSend = resolve;
        onInFlight();
      }),
  });
  const { gate } = await makeGate({ registry });
  try {
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST', headers: auth(gate), signal: controller.signal,
      body: JSON.stringify({
        backendId: 'stub-local', sessionId: 'ses_1',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    // Wait until the turn is genuinely in-flight (sendMessage entered) before
    // aborting. The old fixed 50ms sleep raced the server under full-suite
    // load — the abort could land before the handler reached sendMessage,
    // leaving resolveSend undefined and tripping the resolve below.
    await inFlight;
    controller.abort();
    await pending.catch(() => undefined);
    // The turn only resolves — empty — well after the client already left.
    resolveSend({ text: '', message: { role: 'assistant', content: [] } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const health = await fetch(`http://127.0.0.1:${gate.port}/v1/models`, { headers: auth(gate) });
    assert.equal(health.status, 200);
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

test('a backendId on /v1/models returns only that backend\'s own catalog', async () => {
  const { gate, calls } = await makeGate({ provider: { id: 'nvidia', models: ['01-ai/yi-large'] } });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/models?backendId=stub-local`, { headers: auth(gate) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data.map((m) => m.id), ['stub/one']);
    assert.equal(body.data[0].backendId, 'stub-local');
    assert.ok(
      !body.data.some((m) => m.id === '01-ai/yi-large'),
      'a backend-scoped request must not leak provider models',
    );
    assert.ok(calls.includes('listModels'));
  } finally {
    await gate.close();
  }
});

test('an absent backendId on /v1/models leaves provider behaviour unchanged', async () => {
  const { gate } = await makeGate({ provider: { id: 'nvidia', models: ['01-ai/yi-large'] } });
  try {
    const body = await (await fetch(`http://127.0.0.1:${gate.port}/v1/models`, { headers: auth(gate) })).json();
    const ids = body.data.map((m) => m.id);
    assert.ok(ids.includes('01-ai/yi-large'), 'provider models must still appear without backendId');
    assert.ok(ids.includes('stub/one'), 'the legacy unscoped listing still merges backend models in');
  } finally {
    await gate.close();
  }
});

test('an unknown backendId on /v1/models fails cleanly instead of 500ing', async () => {
  const { gate } = await makeGate();
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/models?backendId=nope`, { headers: auth(gate) });
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error.code, 'unknown_backend');
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

/**
 * The `isKnownAuthenticatedRoute` allowlist (server.mjs) is a second,
 * hand-maintained copy of the route table: a path added to the handler block
 * but not the allowlist 404s ~180 lines earlier and the handler is dead code.
 * Nothing caught that drift, so this walks the manifest's own advertisement and
 * asserts each GET endpoint actually reaches a handler.
 */
test('every GET endpoint the manifest advertises is allowlisted', async () => {
  const { gate } = await makeGate();
  try {
    const manifest = await (await fetch(`http://127.0.0.1:${gate.port}/.well-known/gateway.json`)).json();
    const postOnly = new Set(['chat', 'capabilitiesRpc', 'runs']);
    const checked = [];
    for (const [name, path] of Object.entries(manifest.endpoints)) {
      if (postOnly.has(name) || path.includes('{')) continue;
      const response = await fetch(`http://127.0.0.1:${gate.port}${path}`, { headers: auth(gate) });
      const body = await response.json().catch(() => ({}));
      assert.notEqual(
        body.error,
        'Not Found',
        `${name} (${path}) is advertised but not allowlisted — the handler is unreachable`,
      );
      checked.push(name);
    }
    // Guard against the assertion silently checking nothing.
    assert.ok(checked.includes('toolsets'), `expected toolsets among ${checked.join(', ')}`);
  } finally {
    await gate.close();
  }
});

test('a backend that cannot serve a route gets an answer, not a hung socket', async () => {
  // The stub adapter declares the `tools` capability but its backend has no
  // listToolsets, which is precisely the shape that used to bare-`return`.
  const { gate } = await makeGate();
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/toolsets`, { headers: auth(gate) });
    assert.equal(response.status, 501);
    const body = await response.json();
    assert.equal(body.error.code, 'backend_unsupported');
  } finally {
    await gate.close();
  }
});

test('toolsets are listed from a backend that implements them', async () => {
  const calls = [];
  const registry = stubRegistry(calls);
  const adapter = registry.get('stubcli');
  const createBackend = adapter.createBackend.bind(adapter);
  adapter.createBackend = (...args) => ({
    ...createBackend(...args),
    async listToolsets() { calls.push('listToolsets'); return { toolsets: [{ id: 'fs', tools: ['read'] }] }; },
  });

  const { gate } = await makeGate({ calls, registry });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/toolsets`, { headers: auth(gate) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.toolsets[0].id, 'fs');
    assert.ok(calls.includes('listToolsets'));
  } finally {
    await gate.close();
  }
});

/** A stub that fronts the surfaces Hermes exposes and the Gate now proxies. */
function stubFrontedRegistry(calls) {
  const registry = stubRegistry(calls);
  const adapter = registry.get('stubcli');
  adapter.capabilities = [...adapter.capabilities, 'skills', 'diagnostics', 'cron'];
  const createBackend = adapter.createBackend.bind(adapter);
  adapter.createBackend = (...args) => ({
    ...createBackend(...args),
    async listToolsets() { calls.push('listToolsets'); return { toolsets: [] }; },
    async listSkills() { calls.push('listSkills'); return { data: [{ id: 'skill-1' }] }; },
    async healthDetailed() { calls.push('healthDetailed'); return { status: 'ok', checks: { db: 'ok' } }; },
    async listJobs() { calls.push('listJobs'); return { data: [{ id: 'job-1', paused: false }] }; },
    async runJob(id) { calls.push(`runJob:${id}`); return { started: true }; },
    async setJobPaused(id, paused) { calls.push(`setJobPaused:${id}:${paused}`); return { paused }; },
  });
  return registry;
}

test('skills, diagnostics and cron are advertised only when a backend fronts them', async () => {
  const plain = await makeGate();
  try {
    const manifest = await (await fetch(`http://127.0.0.1:${plain.gate.port}/.well-known/gateway.json`)).json();
    assert.equal(manifest.endpoints.skills, undefined);
    assert.equal(manifest.endpoints.health_detailed, undefined);
    assert.equal(manifest.capabilities.jobs_admin, undefined);
  } finally {
    await plain.gate.close();
  }

  const calls = [];
  const { gate } = await makeGate({ calls, registry: stubFrontedRegistry(calls) });
  try {
    const manifest = await (await fetch(`http://127.0.0.1:${gate.port}/.well-known/gateway.json`)).json();
    assert.equal(manifest.endpoints.skills, '/v1/skills');
    assert.equal(manifest.endpoints.health_detailed, '/health/detailed');
    assert.equal(manifest.endpoints.jobs, '/v1/jobs');
    // Advertised from the Gate's own fronting, not from the backend's self-report.
    assert.equal(manifest.capabilities.jobs_admin, true);
  } finally {
    await gate.close();
  }
});

test('the fronted routes proxy to the backend and are reachable', async () => {
  const calls = [];
  const { gate } = await makeGate({ calls, registry: stubFrontedRegistry(calls) });
  const base = `http://127.0.0.1:${gate.port}`;
  try {
    const skills = await fetch(`${base}/v1/skills`, { headers: auth(gate) });
    assert.equal(skills.status, 200);
    assert.equal((await skills.json()).data[0].id, 'skill-1');

    const health = await fetch(`${base}/health/detailed`, { headers: auth(gate) });
    assert.equal(health.status, 200);
    assert.deepEqual((await health.json()).checks, { db: 'ok' });

    const jobs = await fetch(`${base}/v1/jobs`, { headers: auth(gate) });
    assert.equal(jobs.status, 200);
    assert.equal((await jobs.json()).data[0].id, 'job-1');

    for (const [action, expected] of [['run', 'runJob:job-1'], ['pause', 'setJobPaused:job-1:true'], ['resume', 'setJobPaused:job-1:false']]) {
      const response = await fetch(`${base}/v1/jobs/job-1/${action}`, { method: 'POST', headers: auth(gate) });
      assert.equal(response.status, 200, `${action} should proxy`);
      assert.ok(calls.includes(expected), `${action} should call ${expected}`);
    }
  } finally {
    await gate.close();
  }
});

test('detailed health needs a token even though plain /health does not', async () => {
  const calls = [];
  const { gate } = await makeGate({ calls, registry: stubFrontedRegistry(calls) });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${gate.port}/health`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${gate.port}/health/detailed`)).status, 401);
  } finally {
    await gate.close();
  }
});

test('the Gate dispatches the Hermes-dialect methods the app actually sends', async () => {
  const calls = [];
  const { gate } = await makeGate({ calls, registry: stubFrontedRegistry(calls) });
  const rpc = async (method, params = {}) => {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ method, params }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    for (const method of ['health', 'status', 'diagnostics.full', 'skills.list', 'skills.status',
      'cron.list', 'cron.status', 'sessions.list', 'models.list', 'tools.list']) {
      const { status, body } = await rpc(method);
      assert.equal(status, 200, `${method} should dispatch, got ${JSON.stringify(body)}`);
      assert.ok(body.result !== undefined, `${method} should return a result`);
    }

    assert.equal((await rpc('jobs.run', { jobId: 'job-1' })).status, 200);
    assert.equal((await rpc('jobs.pause', { jobId: 'job-1' })).status, 200);
    assert.equal((await rpc('jobs.resume', { jobId: 'job-1' })).status, 200);
    assert.ok(calls.includes('setJobPaused:job-1:false'));

    // Unknown methods must still be refused, not swallowed by the new map.
    const unknown = await rpc('nope.nope');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'unknown_method');
  } finally {
    await gate.close();
  }
});

test('the manifest advertises the methods the Gate can actually dispatch', async () => {
  const calls = [];
  const { gate } = await makeGate({ calls, registry: stubFrontedRegistry(calls) });
  try {
    const manifest = await (await fetch(`http://127.0.0.1:${gate.port}/.well-known/gateway.json`)).json();
    // An empty list is the failure mode to guard: building the manifest before
    // the RPC tables exist would ship one, and the app would silently render an
    // empty command tab rather than fail loudly.
    assert.ok(manifest.rpcMethods?.length > 0, 'rpcMethods must not be empty');
    for (const method of ['skills.list', 'cron.list', 'tools.list', 'registry.kinds.list']) {
      assert.ok(manifest.rpcMethods.includes(method), `${method} should be advertised`);
    }
    // Advertised implies dispatchable — checked over the read-only methods
    // only. Calling every advertised name would fire `registry.instances.*`
    // and `registry.secrets.set` with empty params, which is a mutation, not
    // a probe.
    const readOnly = manifest.rpcMethods.filter((m) => /\.(list|status)$/.test(m) || m === 'health');
    assert.ok(readOnly.length >= 5, `expected read-only methods among ${manifest.rpcMethods.join(', ')}`);
    for (const method of readOnly) {
      const response = await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
        method: 'POST',
        headers: auth(gate),
        body: JSON.stringify({ method, params: {} }),
      });
      assert.notEqual(response.status, 404, `${method} is advertised but not dispatched`);
    }

    // And the converse: a name absent from the list is genuinely not answered.
    const absent = await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ method: 'definitely.not.a.method', params: {} }),
    });
    assert.equal(absent.status, 404);
  } finally {
    await gate.close();
  }
});
