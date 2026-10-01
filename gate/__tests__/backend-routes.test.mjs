import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate, runVoiceTurn } from '../core/server.mjs';
import { DeviceTokenStore } from '../core/device-tokens.mjs';

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

/** Two run-capable adapters make route ownership observable. */
function runScopeRegistry(calls) {
  const base = stubRegistry(calls).get('stubcli');
  const make = (adapterId) => ({
    ...base,
    adapterId,
    capabilities: [...base.capabilities, 'runs'],
    createBackend() {
      const backend = base.createBackend();
      return {
        ...backend,
        async startRun() { calls.push(`${adapterId}:startRun`); return { run_id: `${adapterId}-run`, status: 'started' }; },
        async getRunStatus() { calls.push(`${adapterId}:getRunStatus`); return { status: 'completed' }; },
        async stopRun() { calls.push(`${adapterId}:stopRun`); },
        async replyApproval() { calls.push(`${adapterId}:replyApproval`); },
        async runEvents() {
          calls.push(`${adapterId}:runEvents`);
          return sseUpstream(['data: {"type":"run.completed"}\n\n']);
        },
      };
    },
  });
  const first = make('first-runs');
  const second = make('second-runs');
  return {
    get(id) {
      if (id === first.adapterId) return first;
      if (id === second.adapterId) return second;
      throw new Error(`unknown CLI adapter "${id}"`);
    },
    list() { return [first, second]; },
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
        async createSession(input) {
          // Records the model so a test can prove the session was born pinned.
          calls.push(`createSession:model=${input?.model?.modelId ?? 'none'}`);
          return { ...SESSION, title: input?.title ?? null };
        },
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

async function makeGate({ calls = [], provider, registry, terminalSessions, environments, pushFetch, backendServerFactory, gateOptions, pairedDevices = [] } = {}) {
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
  // Most tests want one environment; resolution-order tests want several, in a
  // known order, so the id is what the Gate sorts and picks on.
  for (const env of environments ?? [{ id: 'stub-local', adapterId: 'stubcli' }]) {
  await writeFile(join(gateHome, 'config', 'environments', `${env.id}.json`), JSON.stringify({
    schemaVersion: 1,
    kind: 'cli-environment',
    id: env.id,
    label: `Stub ${env.adapterId}`,
    adapterId: env.adapterId,
    executable: { path: 'C:\\stub.exe' },
    protocolPreference: ['acp'],
    versionPolicy: { supported: '1.x', adapterRevision: '1' },
    providerRefs: [],
    workspacePolicy: { roots: ['C:\\ws'], defaultRoot: 'C:\\ws', defaultSandbox: 'workspace_write', allowAdditionalRoots: false },
    lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 1 },
    enabled: true,
  }), 'utf8');
  }

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
    environmentRegistry: registry ?? stubRegistry(calls),
    ...(terminalSessions ? { terminalSessions } : {}),
    // The stub server needs no process: report it as already reachable.
    backendServerFactory: backendServerFactory ?? (() => ({
      ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:1', attached: true }),
      stop: async () => {},
      isOwned: () => false,
    })),
    ...(pushFetch ? { pushFetch } : {}),
    ...(gateOptions ? { ...gateOptions } : {}),
  });
  return { gate, calls, paired };
}

function auth(gate) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` };
}

test('a voice turn names resolve, send, acceptance and response in real order', async () => {
  const stages = [];
  let resolveBackend;
  let releaseSend;
  let sendCalls = 0;
  const backend = {
    id: 'hermes-live',
    sendMessage() {
      sendCalls += 1;
      return new Promise((resolve) => { releaseSend = () => resolve({ text: 'ok' }); });
    },
  };
  const manager = {
    list: async () => [{ id: 'hermes-live' }],
    get: () => new Promise((resolve) => { resolveBackend = () => resolve(backend); }),
  };

  const turn = runVoiceTurn(manager, { thread: { backendId: 'hermes-live', sessionId: 's1' } }, 'hi', {
    attempt: 't1',
    onStage: (detail) => stages.push(detail),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(stages.some((stage) => stage.stage === 'resolve.start'));
  assert.ok(!stages.some((stage) => stage.stage === 'resolve.ready'), 'no backend is chosen yet');
  assert.equal(sendCalls, 0, 'nothing is sent before the backend resolves');

  resolveBackend();
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(stages.some((stage) => stage.stage === 'resolve.ready' && stage.backend === 'hermes-live'));
  assert.equal(sendCalls, 1, 'the resolved backend receives the turn');
  assert.ok(stages.some((stage) => stage.stage === 'turn.send'));

  releaseSend();
  const outcome = await turn;
  assert.equal(outcome.hasContent, true);
  const names = stages.map((stage) => stage.stage);
  assert.ok(names.indexOf('resolve.start') < names.indexOf('resolve.ready'));
  assert.ok(names.indexOf('resolve.ready') < names.indexOf('turn.send'));
  assert.ok(names.indexOf('turn.send') < names.indexOf('turn.accepted'));
  assert.ok(names.indexOf('turn.accepted') < names.indexOf('turn.response'));
});

test('a voice turn that cannot resolve a backend fails at resolve with no send', async () => {
  const stages = [];
  const manager = { list: async () => [], get: async () => null };

  await assert.rejects(
    () => runVoiceTurn(manager, { thread: { backendId: 'gone', sessionId: 's1' } }, 'hi', {
      onStage: (detail) => stages.push(detail),
    }),
    (error) => error?.code === 'no_voice_backend',
  );
  assert.ok(stages.some((stage) => stage.stage === 'resolve.failed' && stage.cause === 'no_voice_backend'));
  assert.ok(!stages.some((stage) => stage.stage === 'turn.send'), 'nothing is sent when no backend resolves');
});

test('an aborted resolution releases at once and a late resolve sends and aborts nothing', async () => {
  const stages = [];
  let resolveBackend;
  let sendCalls = 0;
  let abortCalls = 0;
  const backend = {
    id: 'shared',
    sendMessage() { sendCalls += 1; return { text: 'late' }; },
    abort() { abortCalls += 1; },
  };
  const manager = {
    list: async () => [{ id: 'shared' }],
    get: () => new Promise((resolve) => { resolveBackend = () => resolve(backend); }),
  };

  const caller = new AbortController();
  const turn = runVoiceTurn(manager, { thread: { backendId: 'shared', sessionId: 's1' } }, 'hi', {
    signal: caller.signal,
    onStage: (detail) => stages.push(detail),
  });
  await new Promise((resolve) => setImmediate(resolve));

  caller.abort();
  const outcome = await turn;
  assert.equal(outcome.aborted, true, 'the aborted resolution settles as aborted without the resolver cooperating');
  assert.equal(sendCalls, 0, 'no turn is sent on a resolution the caller left');

  resolveBackend();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sendCalls, 0, 'a late resolution never sends the abandoned turn');
  assert.equal(abortCalls, 0, 'a late resolution never aborts a backend a newer turn may now own');
  assert.ok(!stages.some((stage) => stage.stage === 'turn.send'), 'no send stage is reported after the abort');
});

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

test('sessions.list RPC passes the requested limit to the backend', async () => {
  const seen = [];
  const base = stubRegistry([]).get('stubcli');
  const registry = {
    get(id) {
      if (id !== 'stubcli') throw new Error(`unknown CLI adapter "${id}"`);
      return {
        ...base,
        createBackend() {
          const backend = base.createBackend();
          return {
            ...backend,
            async listSessions(limit) { seen.push(limit); return [SESSION]; },
          };
        },
      };
    },
    list() { return [base]; },
  };
  const { gate } = await makeGate({ registry });
  const rpc = async (params) => {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST', headers: auth(gate),
      body: JSON.stringify({ method: 'sessions.list', params }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    // The spend read asks for 50 and the registry read asks for 10 — both
    // must reach the backend instead of the Hermes default page answering.
    const limited = await rpc({ limit: 50 });
    assert.equal(limited.status, 200, `sessions.list should dispatch, got ${JSON.stringify(limited.body)}`);
    assert.equal(limited.body.result.object, 'list');
    assert.equal(limited.body.result.data[0].id, 'ses_1');
    assert.equal(seen.at(-1), 50);

    // Absent stays undefined so the backend keeps its default page.
    const bare = await rpc({});
    assert.equal(bare.status, 200, `bare sessions.list should dispatch, got ${JSON.stringify(bare.body)}`);
    assert.equal(seen.at(-1), undefined);
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

test('session.messages RPC reads a transcript through the Gate dialect', async () => {
  const { gate, calls } = await makeGate();
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST', headers: auth(gate),
      body: JSON.stringify({ method: 'session.messages', params: { sessionId: 'ses_1', limit: 20 } }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.object, 'list');
    assert.equal(body.result.data[0].role, 'user');
    // The requested limit travels to the backend, not just the REST pager.
    assert.ok(calls.includes('listMessages:ses_1:20'));

    // A missing id is an honest named failure, not an empty read.
    const missing = await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST', headers: auth(gate),
      body: JSON.stringify({ method: 'session.messages', params: {} }),
    });
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error.message, /sessionId is required/);
  } finally {
    await gate.close();
  }
});

test('session.get, session.usage and session.restore read one session through the Gate dialect', async () => {
  const { gate, calls } = await makeGate();
  const rpc = async (method, params = {}) => {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST', headers: auth(gate),
      body: JSON.stringify({ method, params }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    // session.get returns the record itself — the direct shape the
    // command renderer already consumes.
    const got = await rpc('session.get', { sessionId: 'ses_1' });
    assert.equal(got.status, 200, `session.get should dispatch, got ${JSON.stringify(got.body)}`);
    assert.equal(got.body.result.id, 'ses_1');
    assert.equal(got.body.result.title, 'Stub session');

    // session.usage with an id reports that session's counters.
    const usage = await rpc('session.usage', { sessionId: 'ses_1' });
    assert.equal(usage.status, 200, `session.usage should dispatch, got ${JSON.stringify(usage.body)}`);
    assert.equal(usage.body.result.sessionId, 'ses_1');
    assert.equal(usage.body.result.input_tokens, 0);

    // session.usage without an id totals the catalogue instead of
    // demanding an id.
    const all = await rpc('session.usage', {});
    assert.equal(all.status, 200, `bare session.usage should dispatch, got ${JSON.stringify(all.body)}`);
    assert.equal(all.body.result.sessions, 1);

    // session.restore returns the record; the app switches its open
    // thread only after this resolves.
    const restored = await rpc('session.restore', { sessionId: 'ses_1' });
    assert.equal(restored.status, 200, `session.restore should dispatch, got ${JSON.stringify(restored.body)}`);
    assert.equal(restored.body.result.id, 'ses_1');

    // The lookup reads the catalogue behind every method.
    assert.ok(calls.includes('listSessions'));

    // A missing id is an honest named failure, not an empty read.
    // (Bare session.usage needs no id — it totals the catalogue.)
    for (const method of ['session.get', 'session.restore']) {
      const missing = await rpc(method, {});
      assert.equal(missing.status, 400, `${method} without an id should fail honestly`);
      assert.match(missing.body.error.message, /sessionId is required/);
    }

    // An absent id fails honestly on all three — never a wrong session,
    // never an empty success.
    for (const method of ['session.get', 'session.usage', 'session.restore']) {
      const absent = await rpc(method, { sessionId: 'ses_9' });
      assert.equal(absent.status, 400, `${method} with an unknown id should fail honestly`);
      assert.match(absent.body.error.message, /Session not found: ses_9/);
    }
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

test('a content-part turn reaches a CLI backend as its text', async () => {
  const { gate } = await makeGate();
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST', headers: auth(gate),
      body: JSON.stringify({
        backendId: 'stub-local',
        sessionId: 'ses_1',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'ping' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
            ],
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    // The CLI backend speaks text only, so the image part does not travel —
    // the turn must still reach it as the text part, not crash the route.
    assert.equal(body.choices[0].message.content, 'echo ping');
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

test('the chat SSE route exposes thinking and each tool state before final text', async () => {
  const registry = stubTurnRegistry({
    sendMessage: async () => ({
      text: 'Done',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
    }),
    streamEvents: async (id, onEvent, signal) => {
      onEvent({ type: 'message.reasoning.delta', payload: { text: 'checking' } });
      onEvent({ type: 'tool.started', payload: { name: 'Read', callId: 'call-1' } });
      onEvent({ type: 'tool.progress', payload: { name: 'Read', callId: 'call-1', text: 'line 1' } });
      onEvent({ type: 'tool.progress', payload: { name: 'Read', callId: 'call-1', input: { file_path: 'AGENTS.md' }, snapshot: true } });
      onEvent({ type: 'tool.progress', payload: { name: 'Read', callId: 'call-1', input: { file_path: 'AGENTS.md' }, snapshot: true } });
      onEvent({ type: 'tool.output', payload: { name: 'Read', callId: 'call-1', output: 'line 1' } });
      onEvent({ type: 'message.delta', payload: { text: 'Done' } });
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
        messages: [{ role: 'user', content: 'read the file' }], stream: true,
      }),
    });
    assert.equal(response.status, 200);
    const frames = (await response.text()).split('\n')
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) => JSON.parse(line.slice(6)));
    const deltas = frames.flatMap((frame) => frame.choices?.map((choice) => choice.delta) ?? []);
    const reasoning = deltas.findIndex((delta) => delta.reasoning_content === 'checking');
    const start = deltas.findIndex((delta) => delta.tool_calls?.[0]?.status === 'running'
      && delta.tool_calls[0].detail === undefined);
    const progress = deltas.findIndex((delta) => delta.tool_calls?.[0]?.status === 'running'
      && delta.tool_calls[0].detail === 'line 1');
    const argumentsProgress = deltas.findIndex((delta) => delta.tool_calls?.[0]?.status === 'running'
      && delta.tool_calls[0].detail === '{"file_path":"AGENTS.md"}');
    const complete = deltas.findIndex((delta) => delta.tool_calls?.[0]?.status === 'complete');
    const answer = deltas.findIndex((delta) => delta.content === 'Done');
    assert.ok(reasoning >= 0 && reasoning < start);
    assert.ok(start < progress && progress < argumentsProgress && argumentsProgress < complete && complete < answer);
    assert.equal(deltas.filter((delta) => delta.tool_calls?.[0]?.detail === '{"file_path":"AGENTS.md"}').length, 1);
    assert.equal(deltas[complete].tool_calls[0].id, 'call-1');
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

test('the merged model catalog reads independent backends concurrently', async () => {
  const calls = [];
  const base = stubRegistry(calls).get('stubcli');
  let releaseSlow;
  const slowReady = new Promise((resolve) => { releaseSlow = resolve; });
  const makeAdapter = (adapterId) => ({
    ...base,
    adapterId,
    server: { transport: 'per-turn' },
    createBackend() {
      const backend = base.createBackend();
      return {
        ...backend,
        async listModels() {
          calls.push(adapterId);
          if (adapterId === 'a-slow') await slowReady;
          else releaseSlow();
          return [{ id: `${adapterId}/one`, providerId: adapterId, modelId: 'one' }];
        },
      };
    },
  });
  const adapters = [makeAdapter('a-slow'), makeAdapter('b-fast')];
  const registry = {
    get(id) { return adapters.find((adapter) => adapter.adapterId === id); },
    list() { return adapters; },
  };
  const { gate } = await makeGate({
    registry,
    environments: adapters.map((adapter) => ({ id: adapter.adapterId, adapterId: adapter.adapterId })),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/models`, {
      headers: auth(gate),
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data.map((model) => model.id), ['a-slow/one', 'b-fast/one']);
    assert.deepEqual(calls.sort(), ['a-slow', 'b-fast']);
  } finally {
    releaseSlow();
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
    // chatCancel is POST-only, like chat and capabilitiesRpc: this walk probes
    // with GET, and a POST-only path is answered 404 by design.
    const postOnly = new Set(['chat', 'chatCancel', 'capabilitiesRpc', 'runs']);
    const checked = [];
    for (const [name, path] of Object.entries(manifest.endpoints)) {
      if (postOnly.has(name) || path.includes('{')) continue;
      // Only a 404 body is read. Some advertised endpoints stream forever
      // (the terminal), so parsing every response would hang here — and the
      // allowlist rejection is a 404 with this exact shape.
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${gate.port}${path}`, {
        headers: auth(gate),
        signal: controller.signal,
      });
      if (response.status === 404) {
        const body = await response.json().catch(() => ({}));
        assert.notEqual(
          body.error,
          'Not Found',
          `${name} (${path}) is advertised but not allowlisted — the handler is unreachable`,
        );
      }
      controller.abort();
      checked.push(name);
    }
    // Guard against the assertion silently checking nothing.
    for (const expected of ['toolsets', 'terminal']) {
      assert.ok(checked.includes(expected), `expected ${expected} among ${checked.join(', ')}`);
    }
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
  adapter.capabilities = [...adapter.capabilities, 'skills', 'diagnostics', 'cron', 'bots'];
  const createBackend = adapter.createBackend.bind(adapter);
  adapter.createBackend = (...args) => ({
    ...createBackend(...args),
    async listToolsets() { calls.push('listToolsets'); return { toolsets: [] }; },
    async listSkills() { calls.push('listSkills'); return { data: [{ id: 'skill-1' }] }; },
    async healthDetailed() { calls.push('healthDetailed'); return { status: 'ok', checks: { db: 'ok' } }; },
    async listJobs() { calls.push('listJobs'); return { data: [{ id: 'job-1', paused: false }] }; },
    async createJob(body) { calls.push(`createJob:${body?.name}`); return { id: 'job-new', name: body?.name }; },
    async runJob(id) { calls.push(`runJob:${id}`); return { started: true }; },
    async setJobPaused(id, paused) { calls.push(`setJobPaused:${id}:${paused}`); return { paused }; },
    async listBots() {
      calls.push('listBots');
      return { object: 'list', data: [{ id: 'researcher', displayName: 'researcher', routable: true }] };
    },
    async getBot(input) {
      calls.push(`getBot:${input?.id}`);
      if (input?.id === 'nope') {
        const error = new Error('unknown bot "nope"');
        error.code = 'unknown_bot';
        error.status = 404;
        throw error;
      }
      return { id: input.id, displayName: input.id, routable: true, soul: 'You are precise.' };
    },
    async createBot(input) {
      calls.push(`createBot:${input?.name}`);
      return { id: input.name, displayName: input.name, routable: true };
    },
    async updateBot(input) {
      calls.push(`updateBot:${input?.id}`);
      calls.push(`updateBot-body:${JSON.stringify({ modelId: input?.modelId, providerId: input?.providerId })}`);
      if (input?.id === 'nope') {
        const error = new Error('unknown bot "nope"');
        error.code = 'unknown_bot';
        throw error;
      }
      return { id: input?.id, displayName: input?.id, routable: true, description: input?.description ?? null };
    },
    async forBot(botId) {
      calls.push(`forBot:${botId}`);
      if (botId === 'nope') {
        const error = new Error('unknown');
        error.code = 'unknown_bot';
        throw error;
      }
      if (botId === 'silent') {
        const error = new Error('no key');
        error.code = 'bot_not_routable';
        throw error;
      }
      return {
        async listSessions() { calls.push(`listSessions:${botId}`); return [{ ...SESSION, title: 'Bot Chat' }]; },
        async createSession(input) {
          calls.push(`createSession:${botId}:${input?.title}`);
          return { ...SESSION, title: input?.title ?? 'Bot Chat' };
        },
        async listMessages() { return []; },
        async listModels() {
          calls.push(`listModels:${botId}`);
          return [{ id: `${botId}/one`, providerId: botId, modelId: 'one', label: `${botId} · one` }];
        },
        async listJobs() { calls.push(`listJobs:${botId}`); return { data: [{ id: 'job-1' }] }; },
        async createJob(body) { calls.push(`createJob:${botId}:${body?.name}`); return { id: 'job-2', name: body?.name }; },
        async sendMessage() {
          return { text: 'ok', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
        },
      };
    },
    async deliverGroupMessage(input) {
      calls.push(`deliverGroupMessage:${input?.name}:${input?.text}`);
      // Mirrors the real backend: a silent first speaker ends the plan with
      // zero replies.
      if ((input?.memberIds ?? []).includes('silent')) return { replies: [] };
      return { replies: [{ botId: input?.memberIds?.[0] ?? 'coder', text: `echo ${input?.text}` }] };
    },
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
    assert.equal(manifest.endpoints.bots, '/v1/bots');
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

    const bots = await fetch(`${base}/v1/bots`, { headers: auth(gate) });
    assert.equal(bots.status, 200);
    assert.equal((await bots.json()).data[0].id, 'researcher');
    assert.ok(calls.includes('listBots'));
  } finally {
    await gate.close();
  }
});

const frontedRequests = [
  { path: '/v1/toolsets', method: 'GET', operation: 'listToolsets', code: 'toolsets_read_failed', result: { toolsets: [] } },
  { path: '/v1/skills', method: 'GET', operation: 'listSkills', code: 'skills_read_failed', result: { data: [{ id: 'skill-1' }] } },
  { path: '/health/detailed', method: 'GET', operation: 'healthDetailed', code: 'diagnostics_read_failed', result: { status: 'ok', checks: { db: 'ok' } } },
  { path: '/v1/jobs', method: 'GET', operation: 'listJobs', code: 'jobs_read_failed', result: { data: [{ id: 'job-1', paused: false }] } },
  { path: '/v1/jobs', method: 'POST', operation: 'createJob', code: 'job_create_failed', body: { name: 'Daily' }, result: { id: 'job-new', name: 'Daily' } },
  { path: '/v1/jobs/job-1/run', method: 'POST', operation: 'runJob', code: 'job_run_failed', result: { started: true } },
  { path: '/v1/jobs/job-1/pause', method: 'POST', operation: 'setJobPaused', code: 'job_pause_failed', result: { paused: true } },
  { path: '/v1/jobs/job-1/resume', method: 'POST', operation: 'setJobPaused', code: 'job_resume_failed', result: { paused: false } },
];

for (const request of frontedRequests) {
  test(`${request.method} ${request.path} preserves a fronted refusal and its successful wire shape`, async () => {
    const calls = [];
    const registry = stubFrontedRegistry(calls);
    const adapter = registry.get('stubcli');
    const createBackend = adapter.createBackend.bind(adapter);
    let failure = Object.assign(new Error('Hermes temporarily unavailable'), { status: 503, code: 'upstream_unavailable' });
    let shouldFail = true;
    adapter.createBackend = (...args) => {
      const backend = createBackend(...args);
      return {
        ...backend,
        async [request.operation](...input) {
          if (shouldFail) throw failure;
          return backend[request.operation](...input);
        },
      };
    };
    const { gate } = await makeGate({ calls, registry });
    try {
      const send = () => fetch(`http://127.0.0.1:${gate.port}${request.path}`, {
        method: request.method, headers: auth(gate),
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });
      const refused = await send();
      assert.equal(refused.status, 503);
      assert.match(refused.headers.get('content-type'), /application\/json/);
      assert.deepEqual(await refused.json(), {
        error: { message: 'Hermes temporarily unavailable', code: 'upstream_unavailable' },
      });
      for (const status of [200, 399, 600, 502.5, 'invalid', undefined]) {
        failure = Object.assign(new Error('Routine or read unavailable'), { status });
        const invalid = await send();
        assert.equal(invalid.status, 502);
        assert.deepEqual(await invalid.json(), {
          error: { message: 'Routine or read unavailable', code: request.code },
        });
      }
      failure = null;
      const missing = await send();
      assert.equal(missing.status, 502);
      assert.deepEqual(await missing.json(), {
        error: { message: 'Gateway request failed', code: request.code },
      });
      shouldFail = false;
      const success = await send();
      assert.equal(success.status, 200);
      assert.deepEqual(await success.json(), request.result);
    } finally {
      await gate.close();
    }
  });

  test(`${request.method} ${request.path} retains unsupported 501`, async () => {
    const { gate } = await makeGate();
    try {
      const response = await fetch(`http://127.0.0.1:${gate.port}${request.path}`, {
        method: request.method, headers: auth(gate),
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });
      assert.equal(response.status, 501);
      assert.equal((await response.json()).error.code, 'backend_unsupported');
    } finally {
      await gate.close();
    }
  });
}

for (const { label, failure, status, code, message } of [
  { label: 'an inventory refusal', failure: Object.assign(new Error('Roster inventory unavailable'), { status: 503, code: 'inventory_unavailable' }), status: 503, code: 'inventory_unavailable', message: 'Roster inventory unavailable' },
  { label: 'a filesystem failure', failure: new Error('Roster directory unreadable'), status: 502, code: 'bot_read_failed', message: 'Roster directory unreadable' },
  { label: 'an invalid upstream status', failure: Object.assign(new Error('Roster unavailable'), { status: 200, code: 'inventory_unavailable' }), status: 502, code: 'inventory_unavailable', message: 'Roster unavailable' },
  { label: 'a missing diagnostic', failure: null, status: 502, code: 'bot_read_failed', message: 'Could not read the Bot roster' },
]) {
  test(`the Bot roster returns an error envelope for ${label} and can be read again`, async () => {
    const calls = [];
    const registry = stubFrontedRegistry(calls);
    const adapter = registry.get('stubcli');
    const createBackend = adapter.createBackend.bind(adapter);
    let shouldFail = true;
    adapter.createBackend = (...args) => {
      const backend = createBackend(...args);
      return {
        ...backend,
        async listBots() {
          if (shouldFail) throw failure;
          return backend.listBots();
        },
      };
    };
    const { gate } = await makeGate({ calls, registry });
    try {
      const url = `http://127.0.0.1:${gate.port}/v1/bots`;
      const response = await fetch(url, { headers: auth(gate) });
      assert.equal(response.status, status);
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.deepEqual(await response.json(), { error: { message, code } });
      shouldFail = false;
      const retry = await fetch(url, { headers: auth(gate) });
      assert.equal(retry.status, 200);
      assert.deepEqual(await retry.json(), {
        object: 'list', data: [{ id: 'researcher', displayName: 'researcher', routable: true }],
      });
    } finally {
      await gate.close();
    }
  });
}

for (const [method, path] of [
  ['POST', '/v1/jobs'],
  ['POST', '/v1/bots'],
  ['PATCH', '/v1/bots/coder'],
  ['POST', '/v1/sessions'],
  ['POST', '/v1/jobs/job-1/run'],
  ['POST', '/v1/jobs/job-1/pause'],
  ['POST', '/v1/jobs/job-1/resume'],
]) {
  test(`${method} ${path} refuses malformed JSON before calling a Gateway method`, async () => {
    const calls = [];
    const { gate } = await makeGate({ calls, registry: stubFrontedRegistry(calls) });
    try {
      const response = await fetch(`http://127.0.0.1:${gate.port}${path}`, {
        method,
        headers: auth(gate),
        body: '{"name":',
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: { message: 'Request body must be valid JSON', code: 'bad_json' },
      });
      assert.deepEqual(calls, []);
    } finally {
      await gate.close();
    }
  });
}

test('valid empty objects retain route validation and bodyless Routine actions still work', async () => {
  const calls = [];
  const { gate } = await makeGate({ calls, registry: stubFrontedRegistry(calls) });
  const base = `http://127.0.0.1:${gate.port}`;
  try {
    const invalidRpc = await fetch(`${base}/v1/capabilities/rpc`, {
      method: 'POST', headers: auth(gate), body: '{}',
    });
    assert.equal(invalidRpc.status, 400);
    assert.equal((await invalidRpc.json()).error.code, 'invalid_request');
    assert.deepEqual(calls, []);

    const session = await fetch(`${base}/v1/sessions`, {
      method: 'POST', headers: auth(gate), body: '{}',
    });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).title, null);
    assert.deepEqual(calls, ['createSession']);

    const routine = await fetch(`${base}/v1/jobs/job-1/run`, {
      method: 'POST', headers: auth(gate),
    });
    assert.equal(routine.status, 200);
    assert.deepEqual(await routine.json(), { started: true });
    assert.deepEqual(calls, ['createSession', 'runJob:job-1']);
  } finally {
    await gate.close();
  }
});

test('POST /v1/bots creates via createBot', async () => {
  const calls = [];
  const { gate } = await makeGate({ calls, registry: stubFrontedRegistry(calls) });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/bots`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ name: 'coder', inheritKeys: true }),
    });
    assert.equal(response.status, 200);
    assert.ok(calls.includes('createBot:coder'));
  } finally {
    await gate.close();
  }
});

test('PATCH /v1/bots/:id edits through updateBot and maps its errors', async () => {
  const calls = [];
  const { gate } = await makeGate({ calls, registry: stubFrontedRegistry(calls) });
  const base = `http://127.0.0.1:${gate.port}`;
  try {
    const edited = await fetch(`${base}/v1/bots/coder`, {
      method: 'PATCH',
      headers: auth(gate),
      body: JSON.stringify({ description: 'Ships reviews' }),
    });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).description, 'Ships reviews');
    assert.ok(calls.includes('updateBot:coder'));

    const cleared = await fetch(`${base}/v1/bots/coder`, {
      method: 'PATCH',
      headers: auth(gate),
      body: JSON.stringify({ modelId: null, providerId: null }),
    });
    assert.equal(cleared.status, 200);
    assert.ok(calls.includes('updateBot:coder'));
    assert.ok(calls.includes('updateBot-body:{"modelId":null,"providerId":null}'));

    const unknown = await fetch(`${base}/v1/bots/nope`, {
      method: 'PATCH',
      headers: auth(gate),
      body: JSON.stringify({ description: 'x' }),
    });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, 'unknown_bot');

    const unauthenticated = await fetch(`${base}/v1/bots/coder`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'x' }),
    });
    assert.equal(unauthenticated.status, 401);
  } finally {
    await gate.close();
  }
});

test('GET /v1/bots 501s when no backend implements listBots', async () => {
  const { gate } = await makeGate();
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/bots`, { headers: auth(gate) });
    assert.equal(response.status, 501);
    assert.equal((await response.json()).error.code, 'backend_unsupported');
  } finally {
    await gate.close();
  }
});

test('GET /v1/sessions?bot=researcher uses forBot, not the unprefixed backend', async () => {
  const calls = [];
  const { gate } = await makeGate({ calls, registry: stubFrontedRegistry(calls) });
  try {
    const response = await fetch(
      `http://127.0.0.1:${gate.port}/v1/sessions?backendId=stub-local&bot=researcher`,
      { headers: auth(gate) },
    );
    assert.equal(response.status, 200);
    assert.ok(calls.includes('forBot:researcher'));
    assert.ok(calls.includes('listSessions:researcher'));
  } finally {
    await gate.close();
  }
});

test('bot=default still calls forBot(default)', async () => {
  const calls = [];
  const { gate } = await makeGate({ calls, registry: stubFrontedRegistry(calls) });
  try {
    await fetch(`http://127.0.0.1:${gate.port}/v1/sessions?bot=default`, { headers: auth(gate) });
    assert.ok(calls.includes('forBot:default'));
  } finally {
    await gate.close();
  }
});

test('unknown bot is 404, unroutable is 409', async () => {
  const { gate } = await makeGate({ calls: [], registry: stubFrontedRegistry([]) });
  try {
    const unknown = await fetch(`http://127.0.0.1:${gate.port}/v1/sessions?bot=nope`, { headers: auth(gate) });
    assert.equal(unknown.status, 404);
    const silent = await fetch(`http://127.0.0.1:${gate.port}/v1/sessions?bot=silent`, { headers: auth(gate) });
    assert.equal(silent.status, 409);
  } finally {
    await gate.close();
  }
});

test('GET /v1/jobs?bot=researcher lists that Bot cron', async () => {
  const calls = [];
  const { gate } = await makeGate({ calls, registry: stubFrontedRegistry(calls) });
  try {
    const response = await fetch(
      `http://127.0.0.1:${gate.port}/v1/jobs?backendId=stub-local&bot=researcher`,
      { headers: auth(gate) },
    );
    assert.equal(response.status, 200);
    assert.ok(calls.includes('forBot:researcher'));
    assert.ok(calls.includes('listJobs:researcher'));
  } finally {
    await gate.close();
  }
});

test('GET /v1/models?bot=researcher uses that Bot catalog', async () => {
  const calls = [];
  const { gate } = await makeGate({ calls, registry: stubFrontedRegistry(calls) });
  try {
    const response = await fetch(
      `http://127.0.0.1:${gate.port}/v1/models?backendId=stub-local&bot=researcher`,
      { headers: auth(gate) },
    );
    assert.equal(response.status, 200);
    assert.ok(calls.includes('forBot:researcher'));
    assert.ok(calls.includes('listModels:researcher'));
  } finally {
    await gate.close();
  }
});

test('POST /v1/sessions with bot creates on that profile', async () => {
  const calls = [];
  const { gate } = await makeGate({ calls, registry: stubFrontedRegistry(calls) });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/sessions`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ backendId: 'stub-local', bot: 'researcher', title: 'scratch' }),
    });
    assert.equal(response.status, 200);
    assert.ok(calls.includes('forBot:researcher'));
    assert.ok(calls.includes('createSession:researcher:scratch'));
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
      'cron.list', 'cron.status', 'sessions.list', 'models.list', 'tools.list', 'bots.list']) {
      const { status, body } = await rpc(method);
      assert.equal(status, 200, `${method} should dispatch, got ${JSON.stringify(body)}`);
      assert.ok(body.result !== undefined, `${method} should return a result`);
    }

    {
      const { status, body } = await rpc('session.messages', { sessionId: 'ses_1', limit: 10 });
      assert.equal(status, 200, `session.messages should dispatch, got ${JSON.stringify(body)}`);
      assert.equal(body.result.object, 'list');
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

test('cron.jobs reads every jobs envelope key the Routines pane reads', async () => {
  // The Activity tab (listCronJobs -> cron.jobs) must agree with the Routines
  // pane (ManifestClient.listJobs) and /cron (formatCron): all four read
  // data/jobs/crons/items, so a host answering { crons: [...] } or
  // { items: [...] } must not read as empty here.
  const shapes = [
    ['data', { data: [{ id: 'job-1' }] }],
    ['jobs', { jobs: [{ id: 'job-1' }] }],
    ['crons', { crons: [{ id: 'job-1' }] }],
    ['items', { items: [{ id: 'job-1' }] }],
    ['bare-array', [{ id: 'job-1' }]],
  ];
  for (const [shape, listJobsResult] of shapes) {
    const calls = [];
    const registry = stubFrontedRegistry(calls);
    const adapter = registry.get('stubcli');
    const createBackend = adapter.createBackend.bind(adapter);
    adapter.createBackend = (...args) => ({
      ...createBackend(...args),
      async listJobs() { calls.push('listJobs'); return listJobsResult; },
    });
    const { gate } = await makeGate({ calls, registry });
    try {
      const response = await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
        method: 'POST',
        headers: auth(gate),
        body: JSON.stringify({ method: 'cron.jobs', params: {} }),
      });
      assert.equal(response.status, 200, `cron.jobs (${shape}) should dispatch`);
      const body = await response.json();
      assert.equal(body.result.object, 'list');
      assert.equal(body.result.data.length, 1, `cron.jobs (${shape}) must not read empty`);
      assert.equal(body.result.data[0].id, 'job-1');
    } finally {
      await gate.close();
    }
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
    for (const method of ['skills.list', 'cron.list', 'tools.list', 'bots.list', 'registry.kinds.list']) {
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

/** A terminal manager with no real shell behind it. */
function fakeTerminal() {
  const opened = [];
  const sessions = new Map();
  return {
    opened,
    open(handlers) {
      const session = {
        sid: `sid-${opened.length + 1}`,
        owner: handlers.owner ?? null,
        written: [],
        closed: false,
        write(data) { session.written.push(data); },
        close() { session.closed = true; sessions.delete(session.sid); },
        handlers,
      };
      opened.push(session);
      sessions.set(session.sid, session);
      return session;
    },
    get(sid) { return sessions.get(sid) ?? null; },
    closeAll() { for (const s of [...sessions.values()]) s.close(); },
  };
}

/**
 * A stateful SSE frame reader. One reader per response — calling getReader()
 * twice locks the stream, and a predicate that never matches blocks forever.
 */
function sseReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pending = [];
  return {
    async next() {
      while (pending.length === 0) {
        const { done, value } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          pending.push(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
        }
      }
      return pending.shift();
    },
    cancel: () => reader.cancel().catch(() => undefined),
  };
}

/** The `data:` payload of one SSE frame. */
function frameData(frame) {
  const line = frame.split('\n').find((l) => l.startsWith('data: '));
  return line ? line.slice('data: '.length) : '';
}

test('the terminal is advertised because the Gate can actually serve it', async () => {
  const { gate } = await makeGate();
  try {
    const manifest = await (await fetch(`http://127.0.0.1:${gate.port}/.well-known/gateway.json`)).json();
    assert.equal(manifest.capabilities.terminal, true);
    assert.equal(manifest.endpoints.terminal, '/v1/terminal/stream');
  } finally {
    await gate.close();
  }
});

test('the terminal stream refuses an unauthenticated client', async () => {
  const { gate } = await makeGate();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${gate.port}/v1/terminal/stream`)).status, 401);
    const input = await fetch(`http://127.0.0.1:${gate.port}/v1/terminal/input`, {
      method: 'POST',
      body: JSON.stringify({ sid: 'x', data: 'ls\n' }),
    });
    assert.equal(input.status, 401);
  } finally {
    await gate.close();
  }
});

test('the stream hands back a session id, then relays output the client can decode', async () => {
  const terminal = fakeTerminal();
  const { gate } = await makeGate({ terminalSessions: terminal });
  let stream;
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/terminal/stream`, { headers: auth(gate) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

    stream = sseReader(response);
    const opened = await stream.next();
    assert.match(opened, /^event: session/m);
    assert.equal(JSON.parse(frameData(opened)).sid, 'sid-1');

    // Chunks carry base64 UTF-8 with no event name — what client.ts decodes.
    terminal.opened[0].handlers.onChunk('hello\n');
    const chunk = await stream.next();
    assert.ok(!chunk.startsWith('event:'), 'output frames carry no event name');
    assert.equal(Buffer.from(frameData(chunk), 'base64').toString('utf8'), 'hello\n');

    terminal.opened[0].handlers.onExit(0);
    const exited = await stream.next();
    assert.match(exited, /^event: exit/m);
    assert.equal(JSON.parse(frameData(exited)).code, 0);
  } finally {
    await stream?.cancel();
    await gate.close();
  }
});

test('input reaches the shell, and an unknown session is refused', async () => {
  const terminal = fakeTerminal();
  const { gate } = await makeGate({ terminalSessions: terminal });
  const base = `http://127.0.0.1:${gate.port}`;
  let stream;
  try {
    const response = await fetch(`${base}/v1/terminal/stream`, { headers: auth(gate) });
    stream = sseReader(response);
    await stream.next();

    const ok = await fetch(`${base}/v1/terminal/input`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ sid: 'sid-1', data: 'echo hi\n' }),
    });
    assert.equal(ok.status, 200);
    // Verbatim: the app already appended the newline.
    assert.deepEqual(terminal.opened[0].written, ['echo hi\n']);

    const missing = await fetch(`${base}/v1/terminal/input`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ sid: 'nope', data: 'ls\n' }),
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'unknown_session');
  } finally {
    await stream?.cancel();
    await gate.close();
  }
});

test('a refused open arrives as a message, not a silently dead stream', async () => {
  const terminal = {
    open() { throw new Error('too many terminal sessions open (limit 8)'); },
    get() { return null; },
    closeAll() {},
  };
  const { gate } = await makeGate({ terminalSessions: terminal });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/terminal/stream`, { headers: auth(gate) });
    const stream = sseReader(response);
    const frame = await stream.next();
    assert.match(frame, /^event: session/m);
    assert.match(JSON.parse(frameData(frame)).error, /too many terminal sessions/);
    await stream.cancel();
  } finally {
    await gate.close();
  }
});

/** An upstream SSE response built from ready-made frames. */
function sseUpstream(frames) {
  const encoder = new TextEncoder();
  return {
    body: new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
  };
}

const delta = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

/** A backend that streams a turn in one call, the way Hermes does. */
function stubStreamingRegistry({ frames, onCall, streamingError } = {}) {
  const registry = stubRegistry([]);
  const adapter = registry.get('stubcli');
  const createBackend = adapter.createBackend.bind(adapter);
  adapter.createBackend = (...args) => ({
    ...createBackend(...args),
    async sendMessageStreaming(sessionId, input, signal) {
      onCall?.({ sessionId, input, signal });
      if (streamingError) throw streamingError;
      return sseUpstream(frames);
    },
  });
  return registry;
}

test('a streaming backend has its deltas relayed unchanged', async () => {
  const registry = stubStreamingRegistry({
    frames: [delta('Hel'), delta('lo'), 'data: [DONE]\n\n'],
  });
  const { gate } = await makeGate({ registry });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST', headers: auth(gate),
      body: JSON.stringify({
        backendId: 'stub-local', sessionId: 'ses_1',
        messages: [{ role: 'user', content: 'hi' }], stream: true,
      }),
    });
    const text = await response.text();

    assert.match(text, /"content":"Hel"/);
    assert.match(text, /"content":"lo"/);
    // Exactly one terminator: the backend sent its own, which is held back so
    // a client reading until [DONE] does not stop a frame early.
    assert.equal(text.match(/data: \[DONE\]/g)?.length, 1);
    assert.doesNotMatch(text, /empty_turn/);
  } finally {
    await gate.close();
  }
});

for (const [label, code, expected] of [
  ['upstream code', 'capability_unavailable', 'capability_unavailable'],
  ['missing code', undefined, 'backend_error'],
  ['empty code', '', 'backend_error'],
  ['non-string code', { reason: 'unavailable' }, 'backend_error'],
  ['diagnostic text', 'refused: credential=private-value', 'backend_error'],
  ['oversized code', 'a'.repeat(65), 'backend_error'],
]) {
  test(`a streamed refusal preserves a safe error code: ${label}`, async () => {
    const registry = stubStreamingRegistry({
      streamingError: Object.assign(new Error('Hermes is unavailable'), { status: 503, code }),
    });
    const { gate } = await makeGate({ registry });
    try {
      const response = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
        method: 'POST', headers: auth(gate),
        body: JSON.stringify({
          backendId: 'stub-local', sessionId: 'ses_1',
          messages: [{ role: 'user', content: 'hi' }], stream: true,
        }),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/event-stream/);
      assert.equal(await response.text(),
        `data: ${JSON.stringify({ error: { message: 'Hermes is unavailable', code: expected } })}\n\ndata: [DONE]\n\n`);
    } finally {
      await gate.close();
    }
  });
}

test('a streamed refusal keeps partial deltas before the upstream error code and one terminator', async () => {
  const registry = stubTurnRegistry({
    streamEvents: async (_id, onEvent) => {
      onEvent({ type: 'message.delta', payload: { text: 'Partial reply' } });
    },
    sendMessage: async () => {
      throw Object.assign(new Error('Hermes rate limit'), { status: 429, code: 'rate_limit_exceeded' });
    },
  });
  const { gate } = await makeGate({ registry });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST', headers: auth(gate),
      body: JSON.stringify({
        backendId: 'stub-local', sessionId: 'ses_1',
        messages: [{ role: 'user', content: 'hi' }], stream: true,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), delta('Partial reply')
      + 'data: {"error":{"message":"Hermes rate limit","code":"rate_limit_exceeded"}}\n\n'
      + 'data: [DONE]\n\n');
  } finally {
    await gate.close();
  }
});

test('a streamed turn is bound to the session and model the caller asked for', async () => {
  const calls = [];
  const registry = stubStreamingRegistry({
    frames: [delta('ok')],
    onCall: (call) => calls.push(call),
  });
  const { gate } = await makeGate({ registry });
  try {
    await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST', headers: auth(gate),
      body: JSON.stringify({
        backendId: 'stub-local', sessionId: 'ses_7', model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'hi' }], stream: true,
      }),
    });
    assert.equal(calls[0].sessionId, 'ses_7');
    assert.equal(calls[0].input.text, 'hi');
    assert.deepEqual(calls[0].input.model, { providerId: 'openai', modelId: 'gpt-4o' });
    assert.ok(calls[0].signal, 'an abort signal must reach the backend or a walk-away leaks the turn');
  } finally {
    await gate.close();
  }
});

test('a stream that carries nothing still refuses to look like a clean turn', async () => {
  const registry = stubStreamingRegistry({ frames: ['data: [DONE]\n\n'] });
  const { gate } = await makeGate({ registry });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST', headers: auth(gate),
      body: JSON.stringify({
        backendId: 'stub-local', sessionId: 'ses_1',
        messages: [{ role: 'user', content: 'hi' }], stream: true,
      }),
    });
    assert.match(await response.text(), /"code":"empty_turn"/);
  } finally {
    await gate.close();
  }
});

test('a tool-only stream is not mistaken for an empty turn', async () => {
  const toolFrame = `data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read_file' } }] } }],
  })}\n\n`;
  const registry = stubStreamingRegistry({ frames: [toolFrame] });
  const { gate } = await makeGate({ registry });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST', headers: auth(gate),
      body: JSON.stringify({
        backendId: 'stub-local', sessionId: 'ses_1',
        messages: [{ role: 'user', content: 'hi' }], stream: true,
      }),
    });
    const text = await response.text();
    assert.match(text, /read_file/);
    assert.doesNotMatch(text, /empty_turn/);
  } finally {
    await gate.close();
  }
});

test('a refused stream falls back to the whole turn rather than losing the reply', async () => {
  // The cost of a missing streaming endpoint should be tokens arriving all at
  // once, not the user's answer disappearing.
  const registry = stubStreamingRegistry({
    frames: [],
    streamingError: Object.assign(new Error('hermes: HTTP 404'), { status: 404 }),
  });
  const { gate } = await makeGate({ registry });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST', headers: auth(gate),
      body: JSON.stringify({
        backendId: 'stub-local', sessionId: 'ses_1',
        messages: [{ role: 'user', content: 'ping' }], stream: true,
      }),
    });
    const text = await response.text();
    // stubRegistry's sendMessage echoes the prompt back.
    assert.match(text, /echo ping/);
    assert.doesNotMatch(text, /empty_turn/);
    assert.match(text, /\[DONE\]/);
  } finally {
    await gate.close();
  }
});

test('a fronted route picks the backend that can serve it, not the first attached', async () => {
  // The live Gate attaches claude/codex/hermes/opencode; only one fronts the
  // Hermes surfaces. Resolving by position would 501 while a capable backend
  // sat there unused.
  const calls = [];
  const registry = stubRegistry(calls);
  const plain = registry.get('stubcli');
  const capable = {
    ...plain,
    adapterId: 'capablecli',
    capabilities: [...plain.capabilities, 'skills'],
    createBackend: () => ({
      ...plain.createBackend(),
      async listSkills() { calls.push('listSkills'); return { data: [{ id: 'from-capable' }] }; },
    }),
  };
  // `stubcli` is first and cannot serve skills; `capablecli` is second and can.
  const twoBackends = {
    get(id) {
      if (id === 'stubcli') return plain;
      if (id === 'capablecli') return capable;
      throw new Error(`unknown CLI adapter "${id}"`);
    },
    list() { return [plain, capable]; },
  };

  const { gate } = await makeGate({ calls, registry: twoBackends, environments: [{ id: 'a-stub', adapterId: 'stubcli' }, { id: 'b-capable', adapterId: 'capablecli' }] });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/skills`, { headers: auth(gate) });
    assert.equal(response.status, 200, 'the capable backend should have answered');
    assert.equal((await response.json()).data[0].id, 'from-capable');
  } finally {
    await gate.close();
  }
});

test('run lifecycle routes stay on an explicit backend while unpinned creation auto-resolves', async () => {
  const calls = [];
  const { gate } = await makeGate({
    calls,
    registry: runScopeRegistry(calls),
    environments: [
      { id: 'a-first', adapterId: 'first-runs' },
      { id: 'b-second', adapterId: 'second-runs' },
    ],
  });
  const baseUrl = `http://127.0.0.1:${gate.port}`;
  try {
    const unpinned = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ input: 'auto resolve' }),
    });
    const firstRunId = (await unpinned.json()).run_id;
    assert.ok(firstRunId, 'the Gate returns a usable run handle');

    const scoped = '?backendId=b-second';
    const started = await fetch(`${baseUrl}/v1/runs${scoped}`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ input: 'stay here' }),
    });
    const secondRunId = (await started.json()).run_id;
    assert.ok(secondRunId);

    const status = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(secondRunId)}${scoped}`, { headers: auth(gate) });
    assert.equal((await status.json()).status, 'completed');

    const events = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(secondRunId)}/events${scoped}`, { headers: auth(gate) });
    assert.equal(await events.text(), 'data: {"type":"run.completed"}\n\n');

    const approval = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(secondRunId)}/approval${scoped}`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ approved: true }),
    });
    assert.equal(approval.status, 200);

    const stopped = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(secondRunId)}/stop${scoped}`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({}),
    });
    assert.equal(stopped.status, 200);

    assert.deepEqual(calls, [
      'first-runs:startRun',
      'second-runs:startRun',
      'second-runs:getRunStatus',
      'second-runs:runEvents',
      'second-runs:replyApproval',
      'second-runs:stopRun',
    ]);
  } finally {
    await gate.close();
  }
});

test('a run handle keeps status, stop and approval on the CLI environment that started it', async () => {
  const calls = [];
  const { gate } = await makeGate({
    calls,
    registry: runScopeRegistry(calls),
    environments: [
      { id: 'a-first', adapterId: 'first-runs' },
      { id: 'b-second', adapterId: 'second-runs' },
    ],
  });
  const baseUrl = `http://127.0.0.1:${gate.port}`;
  try {
    const started = await fetch(`${baseUrl}/v1/runs?backendId=b-second`, {
      method: 'POST', headers: auth(gate), body: JSON.stringify({ input: 'stay here' }),
    });
    const runId = (await started.json()).run_id;
    const path = `${baseUrl}/v1/runs/${encodeURIComponent(runId)}`;
    assert.equal((await fetch(path, { headers: auth(gate) })).status, 200);
    for (const action of ['approval', 'stop']) {
      const response = await fetch(`${path}/${action}`, {
        method: 'POST', headers: auth(gate), body: JSON.stringify({ approved: false }),
      });
      assert.equal(response.status, 200);
    }
    assert.deepEqual(calls, [
      'second-runs:startRun', 'second-runs:getRunStatus',
      'second-runs:replyApproval', 'second-runs:stopRun',
    ]);
    const conflict = await fetch(`${path}/stop?backendId=a-first`, {
      method: 'POST', headers: auth(gate), body: '{}',
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, 'run_backend_mismatch');
    const missing = await fetch(`${path}?backendId=missing`, { headers: auth(gate) });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'unknown_backend');
    assert.equal(calls.length, 4, 'refused controls never reach another environment');
  } finally {
    await gate.close();
  }
});

test('no attached backend implementing a fronted route is a named 501', async () => {
  const { gate } = await makeGate();
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/skills`, { headers: auth(gate) });
    assert.equal(response.status, 501);
    const body = await response.json();
    assert.equal(body.error.code, 'backend_unsupported');
    assert.match(body.error.message, /listSkills/);
  } finally {
    await gate.close();
  }
});

test('a shell session only accepts input from the credential that opened it', async () => {
  // A session is a live process on the host. Another valid token has no
  // business typing into one it did not open.
  const terminal = fakeTerminal();
  const { gate } = await makeGate({ terminalSessions: terminal });
  const base = `http://127.0.0.1:${gate.port}`;
  let stream;
  try {
    const response = await fetch(`${base}/v1/terminal/stream`, { headers: auth(gate) });
    stream = sseReader(response);
    await stream.next();
    assert.ok(terminal.opened[0].owner, 'the session must record an owner');

    // Same credential: accepted.
    const mine = await fetch(`${base}/v1/terminal/input`, {
      method: 'POST', headers: auth(gate), body: JSON.stringify({ sid: 'sid-1', data: 'ok' }),
    });
    assert.equal(mine.status, 200);

    // A different owner is refused, and told nothing about the session existing.
    terminal.opened[0].owner = 'someone-else';
    const theirs = await fetch(`${base}/v1/terminal/input`, {
      method: 'POST', headers: auth(gate), body: JSON.stringify({ sid: 'sid-1', data: 'whoami' }),
    });
    assert.equal(theirs.status, 404);
    assert.equal((await theirs.json()).error.code, 'unknown_session');
    assert.deepEqual(terminal.opened[0].written, ['ok'], 'the refused write must not reach the shell');
  } finally {
    await stream?.cancel();
    await gate.close();
  }
});

test('bot groups: manifest advertisement, rename, and leave round-trips', async () => {
  const calls = [];
  const { gate } = await makeGate({ calls, registry: groupRosterRegistry(calls) });
  const base = `http://127.0.0.1:${gate.port}`;
  try {
    // The room endpoints ride the bots capability: same gate that fronts bots.
    const manifest = await (await fetch(`${base}/.well-known/gateway.json`)).json();
    assert.equal(manifest.endpoints.botGroups, '/v1/bot-groups');

    const created = await (await fetch(`${base}/v1/bot-groups`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ name: 'crew', memberIds: ['researcher', 'coder', 'writer'] }),
    })).json();
    assert.deepEqual(created.memberIds, ['researcher', 'coder', 'writer']);

    const renamed = await fetch(`${base}/v1/bot-groups/${created.id}`, {
      method: 'PATCH',
      headers: auth(gate),
      body: JSON.stringify({ name: 'bridge crew' }),
    });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).name, 'bridge crew');

    const left = await fetch(`${base}/v1/bot-groups/${created.id}/leave`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ memberId: 'writer' }),
    });
    assert.equal(left.status, 200);
    assert.deepEqual((await left.json()).memberIds, ['researcher', 'coder']);

    // At the two-member floor a leave would dissolve the room — refused with
    // the named reason instead of silently breaking the minimum.
    const floored = await fetch(`${base}/v1/bot-groups/${created.id}/leave`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ memberId: 'coder' }),
    });
    assert.equal(floored.status, 400);
    assert.equal((await floored.json()).error.code, 'too_few_members');

    const unknownGroup = await fetch(`${base}/v1/bot-groups/nope`, {
      method: 'PATCH',
      headers: auth(gate),
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(unknownGroup.status, 404);

    const blankName = await fetch(`${base}/v1/bot-groups/${created.id}`, {
      method: 'PATCH',
      headers: auth(gate),
      body: JSON.stringify({ name: '   ' }),
    });
    assert.equal(blankName.status, 400);

    // Both new routes sit behind the token like every other room route.
    const unauthenticated = await fetch(`${base}/v1/bot-groups/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(unauthenticated.status, 401);
  } finally {
    await gate.close();
  }
});

test('bot groups: sends are recorded Gate-side and replayed as room history', async () => {
  const calls = [];
  const { gate } = await makeGate({ calls, registry: groupRosterRegistry(calls) });
  const base = `http://127.0.0.1:${gate.port}`;
  try {
    const created = await (await fetch(`${base}/v1/bot-groups`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ name: 'crew', memberIds: ['researcher', 'coder'] }),
    })).json();

    // A fresh room replays nothing.
    const empty = await (await fetch(`${base}/v1/bot-groups/${created.id}/messages`, { headers: auth(gate) })).json();
    assert.deepEqual(empty, { object: 'list', data: [] });

    const sent = await (await fetch(`${base}/v1/bot-groups/${created.id}/messages`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ text: 'status?', mentionedIds: ['researcher'] }),
    })).json();
    assert.deepEqual(sent.replies, [{ botId: 'researcher', text: 'echo status?' }]);

    // The send is now the room's transcript: operator line first, then each
    // reply attributed to its bot — so a revisit replays instead of starting
    // blank.
    const historyResponse = await fetch(`${base}/v1/bot-groups/${created.id}/messages`, { headers: auth(gate) });
    assert.equal(historyResponse.status, 200);
    const history = (await historyResponse.json()).data;
    assert.equal(history.length, 2);
    assert.equal(history[0].role, 'user');
    assert.equal(history[0].text, 'status?');
    assert.equal(history[1].role, 'bot');
    assert.equal(history[1].botId, 'researcher');
    assert.equal(history[1].text, 'echo status?');

    // A silent round (first speaker silent → zero replies) still records the
    // operator's line.
    const hushed = await (await fetch(`${base}/v1/bot-groups`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ name: 'hush', memberIds: ['silent', 'coder'] }),
    })).json();
    const hushedSent = await (await fetch(`${base}/v1/bot-groups/${hushed.id}/messages`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ text: 'anyone there?' }),
    })).json();
    assert.deepEqual(hushedSent.replies, []);
    const hushedHistory = (await (await fetch(`${base}/v1/bot-groups/${hushed.id}/messages`, { headers: auth(gate) })).json()).data;
    assert.equal(hushedHistory.length, 1);
    assert.equal(hushedHistory[0].role, 'user');
    assert.equal(hushedHistory[0].text, 'anyone there?');

    const unknownRoom = await fetch(`${base}/v1/bot-groups/nope/messages`, { headers: auth(gate) });
    assert.equal(unknownRoom.status, 404);
    assert.equal((await unknownRoom.json()).error.code, 'unknown_group');

    const unauthenticated = await fetch(`${base}/v1/bot-groups/${created.id}/messages`);
    assert.equal(unauthenticated.status, 401);
  } finally {
    await gate.close();
  }
});

test('bot groups: a room disbanded while the round runs says so instead of a pristine round', async () => {
  const calls = [];
  const registry = groupRosterRegistry(calls);
  const adapter = registry.get('stubcli');
  const createBackend = adapter.createBackend.bind(adapter);
  let gateRef = null;
  let disbandedId = '';
  adapter.createBackend = (...args) => {
    const backend = createBackend(...args);
    backend.deliverGroupMessage = async (input) => {
      calls.push(`deliverGroupMessage:${input?.name}:${input?.text}`);
      // The round runs — and meanwhile the operator disbands the room on
      // another device, before the Gate can store the transcript.
      const response = await fetch(
        `http://127.0.0.1:${gateRef.port}/v1/bot-groups/${disbandedId}`,
        { method: 'DELETE', headers: auth(gateRef) },
      );
      calls.push(`disbandDuringSend:${response.status}`);
      return { replies: [{ botId: 'researcher', text: 'echo status?' }] };
    };
    return backend;
  };
  const { gate } = await makeGate({ calls, registry });
  gateRef = gate;
  const base = `http://127.0.0.1:${gate.port}`;
  try {
    const created = await (await fetch(`${base}/v1/bot-groups`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ name: 'crew', memberIds: ['researcher', 'coder'] }),
    })).json();
    disbandedId = created.id;

    const sent = await (await fetch(`${base}/v1/bot-groups/${created.id}/messages`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ text: 'status?' }),
    })).json();
    assert.equal(sent.roomDisbanded, true, 'the response names the lost transcript');
    assert.deepEqual(sent.replies, [{ botId: 'researcher', text: 'echo status?' }]);
    assert.ok(calls.includes('disbandDuringSend:200'), 'the mid-send disband really landed');

    // The room is really gone: a replay 404s instead of showing lines that
    // never landed.
    const gone = await fetch(`${base}/v1/bot-groups/${created.id}/messages`, { headers: auth(gate) });
    assert.equal(gone.status, 404);
    assert.equal((await gone.json()).error.code, 'unknown_group');
  } finally {
    await gate.close();
  }
});
// ─── model substitution must be visible ─────────────────────────────
// Reproduced live 2026-08-24: ask Hermes for longcat-2.0 on a session that
// already has history and `fallback_providers` answers as deepseek-v4-flash.
// Hermes reports the swap (runtime.model vs runtime.requested); the Gate threw
// it away, so the app kept showing the model the operator picked and the
// substitution was undetectable from the phone.

test('a turn reports the model that actually answered', async () => {
  const registry = stubTurnRegistry({
    sendMessage: async () => ({
      text: 'ok',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      runtime: {
        provider: 'opencode-go',
        model: 'deepseek-v4-flash',
        requested: { provider: 'opencode-go', model: 'longcat-2.0' },
      },
    }),
  });
  const { gate } = await makeGate({ registry });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST', headers: auth(gate),
      body: JSON.stringify({
        backendId: 'stub-local', sessionId: 'ses_1',
        model: 'opencode-go/longcat-2.0',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.model, 'deepseek-v4-flash', 'the answer names what ran, not what was asked');
    assert.equal(body.requested_model, 'longcat-2.0');
  } finally {
    await gate.close();
  }
});

test('a streamed turn announces a substituted model on the wire', async () => {
  const registry = stubTurnRegistry({
    sendMessage: async () => ({
      text: 'ok',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      runtime: {
        provider: 'opencode-go',
        model: 'deepseek-v4-flash',
        requested: { provider: 'opencode-go', model: 'longcat-2.0' },
      },
    }),
  });
  const { gate } = await makeGate({ registry });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST', headers: auth(gate),
      body: JSON.stringify({
        backendId: 'stub-local', sessionId: 'ses_1',
        model: 'opencode-go/longcat-2.0',
        messages: [{ role: 'user', content: 'ping' }],
        stream: true,
      }),
    });
    const text = await response.text();
    const frames = text.split('\n\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6));
    const announced = frames.map((f) => { try { return JSON.parse(f); } catch { return null; } })
      .find((f) => f && f.model);
    assert.ok(announced, `no frame carried the model: ${text.slice(0, 300)}`);
    assert.equal(announced.model, 'deepseek-v4-flash');
    assert.equal(announced.requested_model, 'longcat-2.0');
  } finally {
    await gate.close();
  }
});

test('a turn that ran what was asked reports no substitution', async () => {
  const registry = stubTurnRegistry({
    sendMessage: async () => ({
      text: 'ok',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      runtime: { provider: 'opencode-go', model: 'longcat-2.0', requested: { model: 'longcat-2.0' } },
    }),
  });
  const { gate } = await makeGate({ registry });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST', headers: auth(gate),
      body: JSON.stringify({
        backendId: 'stub-local', sessionId: 'ses_1',
        model: 'opencode-go/longcat-2.0',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    const body = await response.json();
    assert.equal(body.model, 'longcat-2.0');
    assert.equal(body.requested_model, 'longcat-2.0');
  } finally {
    await gate.close();
  }
});

/**
 * Group rooms are roster-guarded since the unknown-member refusal: writes
 * verify every requested id against what the fronted backend's listBots
 * reports. This variant widens the shared stub roster so room fixtures can
 * name coder / writer / silent without changing what the other suites pin
 * about listBots payloads. An optional `roster` array becomes the source of
 * truth for listBots, so a test can simulate the host's roster changing
 * mid-flight (an environment reorder) and watch the door checks react.
 */
function groupRosterRegistry(calls, roster) {
  const registry = stubFrontedRegistry(calls);
  const adapter = registry.get('stubcli');
  const createBackend = adapter.createBackend.bind(adapter);
  adapter.createBackend = (...args) => {
    const backend = createBackend(...args);
    const listBots = backend.listBots.bind(backend);
    backend.listBots = async () => {
      const result = await listBots();
      return {
        ...result,
        data: [...result.data, ...(roster ?? [{ id: 'coder' }, { id: 'writer' }, { id: 'silent' }])],
      };
    };
    return backend;
  };
  return registry;
}

test('bot groups: a member no bot answers to dies at the door, not on first send', async () => {
  const calls = [];
  const { gate } = await makeGate({ calls, registry: groupRosterRegistry(calls) });
  const base = `http://127.0.0.1:${gate.port}`;
  try {
    const refused = await fetch(`${base}/v1/bot-groups`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ name: 'crew', memberIds: ['researcher', 'ghost'] }),
    });
    assert.equal(refused.status, 400);
    const body = await refused.json();
    assert.equal(body.error.code, 'unknown_member');
    assert.match(body.error.message, /ghost/);

    // Nothing was persisted: the room list stays empty, so nobody ever meets
    // this room again as a mid-demo 404 on its first message.
    const rooms = await (await fetch(`${base}/v1/bot-groups`, { headers: auth(gate) })).json();
    assert.deepEqual(rooms.data, []);
  } finally {
    await gate.close();
  }
});

test('bot groups: the send door re-checks the live roster before any bot speaks', async () => {
  const calls = [];
  const roster = [{ id: 'coder' }, { id: 'writer' }];
  const { gate } = await makeGate({ calls, registry: groupRosterRegistry(calls, roster) });
  const base = `http://127.0.0.1:${gate.port}`;
  try {
    const created = await (await fetch(`${base}/v1/bot-groups`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ name: 'crew', memberIds: ['researcher', 'coder'] }),
    })).json();

    // The host's roster changes between the create door check and the first
    // message: coder is no longer a bot this Gate can address. The send must
    // refuse at ITS door with the membership verdict — not die halfway
    // through the round after some bots already spoke.
    roster.splice(0, 1);
    const refused = await fetch(`${base}/v1/bot-groups/${created.id}/messages`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ text: 'status?' }),
    });
    assert.equal(refused.status, 400);
    const body = await refused.json();
    assert.equal(body.error.code, 'unknown_member');
    assert.match(body.error.message, /coder/);

    // No bot spoke and no partial transcript was recorded: the refusal
    // landed at the door, before the round could start.
    assert.ok(!calls.some((call) => call.startsWith('deliverGroupMessage')));
    const history = (await (await fetch(`${base}/v1/bot-groups/${created.id}/messages`, { headers: auth(gate) })).json()).data;
    assert.deepEqual(history, []);

    // The member the refusal names is evictable: leave exempts roster-dead
    // members from the two-member floor, so this room recovers in place
    // instead of meeting its ghost on every send.
    const left = await (await fetch(`${base}/v1/bot-groups/${created.id}/leave`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ memberId: 'coder' }),
    })).json();
    assert.deepEqual(left.memberIds, ['researcher']);
  } finally {
    await gate.close();
  }
});

test('bot groups: an unreachable roster refuses the write instead of guessing', async () => {
  const calls = [];
  // Default stub registry: its backend implements no listBots, so membership
  // cannot be verified — the honest answer is a refusal, not a room built on
  // hope that would die wholesale on its first send anyway.
  const { gate } = await makeGate({ calls });
  const base = `http://127.0.0.1:${gate.port}`;
  try {
    const refused = await fetch(`${base}/v1/bot-groups`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ name: 'crew', memberIds: ['researcher', 'coder'] }),
    });
    assert.equal(refused.status, 502);
    assert.equal((await refused.json()).error.code, 'roster_unavailable');
  } finally {
    await gate.close();
  }
});

test('bot groups: a patch that names members AND a blank name lands nowhere', async () => {
  const calls = [];
  const { gate } = await makeGate({ calls, registry: groupRosterRegistry(calls) });
  const base = `http://127.0.0.1:${gate.port}`;
  try {
    const created = await (await fetch(`${base}/v1/bot-groups`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ name: 'crew', memberIds: ['researcher', 'coder'] }),
    })).json();

    // Historically the add landed, THEN the blank-name rename threw — a
    // half-applied patch. The name is validated before anything mutates now,
    // so the room keeps both its name and its original roster.
    const patched = await fetch(`${base}/v1/bot-groups/${created.id}`, {
      method: 'PATCH',
      headers: auth(gate),
      body: JSON.stringify({ name: '   ', memberIds: ['writer'] }),
    });
    assert.equal(patched.status, 400);
    assert.equal((await patched.json()).error.code, 'invalid_group');

    const room = await (await fetch(`${base}/v1/bot-groups`, { headers: auth(gate) })).json();
    assert.equal(room.data[0].name, 'crew');
    assert.deepEqual(room.data[0].memberIds, ['researcher', 'coder']);

    // An unknown member in a patch is equally all-or-nothing: members are
    // applied first, so their refusal must stop the valid name from landing
    // either.
    const poisoned = await fetch(`${base}/v1/bot-groups/${created.id}`, {
      method: 'PATCH',
      headers: auth(gate),
      body: JSON.stringify({ name: 'renamed', memberIds: ['ghost'] }),
    });
    assert.equal(poisoned.status, 400);
    assert.equal((await poisoned.json()).error.code, 'unknown_member');
    const after = await (await fetch(`${base}/v1/bot-groups`, { headers: auth(gate) })).json();
    assert.deepEqual(after.data[0].memberIds, ['researcher', 'coder']);
    assert.equal(after.data[0].name, 'crew', 'the good half of a poisoned patch must not land');
  } finally {
    await gate.close();
  }
});

// ─── the model must be pinned when the turn opens the session ────────
// Reported 2026-08-25: every fresh thread answered on an unrequested NVIDIA
// model, and the operator had to pick a model, watch the session be released,
// and send again before being heard. The cause was ordering — the chat route
// created the session BEFORE parsing body.model, so the session was born with
// no model. A Hermes session's model is immutable, so the per-turn model that
// followed could never correct it.

test('a turn that has to open a session pins the requested model to it', async () => {
  const calls = [];
  const registry = stubTurnRegistry({
    calls,
    sendMessage: async () => ({ text: 'ok', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
  });
  const { gate } = await makeGate({ registry });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST', headers: auth(gate),
      body: JSON.stringify({
        backendId: 'stub-local',
        // No sessionId: this is the first turn of a thread, the case that broke.
        messages: [{ role: 'user', content: 'ping' }],
        model: 'moonshot/kimi-k2.5',
      }),
    });
    assert.equal(response.status, 200);
    assert.ok(
      calls.includes('createSession:model=kimi-k2.5'),
      `session was not pinned to the requested model: ${JSON.stringify(calls)}`,
    );
  } finally {
    await gate.close();
  }
});

test('a turn with no model still opens a session, leaving the backend default', async () => {
  // A Bot carries its own model in its Hermes profile. Sending nothing is how
  // the app says "answer as yourself", so this must not invent a model.
  const calls = [];
  const registry = stubTurnRegistry({
    calls,
    sendMessage: async () => ({ text: 'ok', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
  });
  const { gate } = await makeGate({ registry });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST', headers: auth(gate),
      body: JSON.stringify({ backendId: 'stub-local', messages: [{ role: 'user', content: 'ping' }] }),
    });
    assert.equal(response.status, 200);
    assert.ok(calls.includes('createSession:model=none'), JSON.stringify(calls));
  } finally {
    await gate.close();
  }
});

test('a turn on an existing session does not open another one', async () => {
  const calls = [];
  const registry = stubTurnRegistry({
    calls,
    sendMessage: async () => ({ text: 'ok', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
  });
  const { gate } = await makeGate({ registry });
  try {
    await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
      method: 'POST', headers: auth(gate),
      body: JSON.stringify({
        backendId: 'stub-local', sessionId: 'ses_1',
        messages: [{ role: 'user', content: 'ping' }], model: 'moonshot/kimi-k2.5',
      }),
    });
    assert.ok(!calls.some((entry) => entry.startsWith('createSession')), JSON.stringify(calls));
  } finally {
    await gate.close();
  }
});

// Two turns that read identically are still two turns: the notifier used to key
// a chat reply on sessionId + text, so a Session's second identical answer
// stayed silent. The push seam attaches a per-turn id (tested here end to end),
// so each completed turn pushes its own notice while a replayed event still
// collapses.
test('two final responses with identical text in one Session each push their own notice', async () => {
  const calls = [];
  const registry = stubTurnRegistry({
    calls,
    sendMessage: async () => ({ text: 'same answer', message: { role: 'assistant', content: [{ type: 'text', text: 'same answer' }] } }),
  });
  const pushSends = [];
  const pushFetch = async (url, init) => {
    if (url.endsWith('/push/send')) {
      const messages = JSON.parse(init.body);
      pushSends.push(messages);
      return {
        ok: true,
        status: 200,
        async json() { return { data: messages.map((message, index) => ({ status: 'ok', id: `ticket-${index}` })) }; },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        const ids = JSON.parse(init.body).ids;
        return { data: Object.fromEntries(ids.map((id) => [id, { status: 'ok' }])) };
      },
    };
  };
  const { gate } = await makeGate({ calls, registry, pushFetch });
  const base = `http://127.0.0.1:${gate.port}`;
  try {
    const register = await fetch(`${base}/v1/capabilities/rpc`, {
      method: 'POST', headers: auth(gate),
      body: JSON.stringify({
        method: 'notifications.register',
        params: {
          expoPushToken: 'ExponentPushToken[phone]',
          platform: 'ios',
          timezone: 'UTC',
          deviceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        },
      }),
    });
    assert.equal(register.status, 200);
    const enable = await fetch(`${base}/v1/capabilities/rpc`, {
      method: 'POST', headers: auth(gate),
      body: JSON.stringify({
        method: 'notifications.preferences.set',
        params: { enabled: true, deviceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' },
      }),
    });
    assert.equal(enable.status, 200);

    const turn = {
      backendId: 'stub-local', sessionId: 'ses_1',
      messages: [{ role: 'user', content: 'say it twice' }],
    };
    const first = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: auth(gate), body: JSON.stringify(turn) });
    assert.equal(first.status, 200);
    const second = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: auth(gate), body: JSON.stringify(turn) });
    assert.equal(second.status, 200);
    assert.ok(calls.filter((entry) => entry === 'sendMessage').length >= 2, JSON.stringify(calls));

    // The push send is best-effort and fire-and-forget, so it can land a tick
    // after both turns answer. Bounded poll, same idiom as backend-run-events.
    const deadline = Date.now() + 2000;
    while (pushSends.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(pushSends.length, 2, 'two identical-text replies must each reach the phone');
    for (const batch of pushSends) {
      assert.equal(batch.length, 1, 'one reply notice per turn');
      assert.equal(batch[0].data.kind, 'reply');
      assert.equal(batch[0].data.sessionId, 'ses_1');
    }
  } finally {
    await gate.close();
  }
});

test('GET /v1/bots/:id fronts one Bot with its soul, and refuses an unknown one', async () => {
  const calls = [];
  const { gate } = await makeGate({ calls, registry: stubFrontedRegistry(calls) });
  const base = `http://127.0.0.1:${gate.port}`;
  try {
    const one = await fetch(`${base}/v1/bots/researcher`, { headers: auth(gate) });
    assert.equal(one.status, 200);
    const body = await one.json();
    assert.equal(body.id, 'researcher');
    assert.equal(body.soul, 'You are precise.');
    assert.ok(calls.includes('getBot:researcher'));

    const missing = await fetch(`${base}/v1/bots/nope`, { headers: auth(gate) });
    assert.equal(missing.status, 404);
  } finally {
    await gate.close();
  }
});

test('the bots.get RPC returns one Bot with its soul', async () => {
  const calls = [];
  const { gate } = await makeGate({ calls, registry: stubFrontedRegistry(calls) });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ method: 'bots.get', params: { id: 'researcher' } }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.id, 'researcher');
    assert.equal(body.result.soul, 'You are precise.');
    assert.ok(calls.includes('getBot:researcher'));
  } finally {
    await gate.close();
  }
});

// ─── resolving a route by capability, without starting what cannot serve it ───
// On a Gate with claude/codex/hermes/opencode attached, the first roster read
// after a restart used to cold-start the Codex app-server (and every other
// earlier backend) purely to learn that it has no listBots. Each of those
// starts is a process, a handshake and up to 30 seconds.

/** `a-plain` cannot serve bots; `b-capable` can. Records which one is started. */
function mixedRosterRegistry(calls, { probeRefuses = false } = {}) {
  const plain = stubRegistry(calls).get('stubcli');
  const capable = {
    ...plain,
    adapterId: 'capablecli',
    capabilities: [...plain.capabilities, 'bots'],
    createBackend(options) {
      if (probeRefuses && options?.baseUrl === 'http://127.0.0.1:0') {
        throw new Error('this adapter cannot be probed');
      }
      return {
        ...plain.createBackend(options),
        async listBots() {
          calls.push('listBots');
          return { object: 'list', data: [{ id: 'researcher', displayName: 'researcher', routable: true }] };
        },
      };
    },
  };
  return {
    get(id) {
      if (id === 'stubcli') return plain;
      if (id === 'capablecli') return capable;
      throw new Error(`unknown CLI adapter "${id}"`);
    },
    list() { return [plain, capable]; },
  };
}

function recordingServerFactory(started) {
  return ({ record }) => ({
    ensureRunning: async () => {
      started.push(record.id);
      return { baseUrl: 'http://127.0.0.1:1', attached: true };
    },
    stop: async () => {},
    isOwned: () => false,
  });
}

const MIXED_ROSTER = [
  { id: 'a-plain', adapterId: 'stubcli' },
  { id: 'b-capable', adapterId: 'capablecli' },
];

test('a backend that cannot serve the route is never started', async () => {
  const calls = [];
  const started = [];
  const { gate } = await makeGate({
    calls,
    registry: mixedRosterRegistry(calls),
    environments: MIXED_ROSTER,
    backendServerFactory: recordingServerFactory(started),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/bots`, { headers: auth(gate) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data[0].id, 'researcher');
    assert.ok(calls.includes('listBots'), 'the capable backend answered');
    assert.deepEqual(started, ['b-capable'], 'the backend that cannot answer must never be started');
  } finally {
    await gate.close();
  }
});

test('an explicit backendId still starts the environment it names', async () => {
  const calls = [];
  const started = [];
  const { gate } = await makeGate({
    calls,
    registry: mixedRosterRegistry(calls),
    environments: MIXED_ROSTER,
    backendServerFactory: recordingServerFactory(started),
  });
  try {
    // A deliberate pin is still answered, still told the truth, and still costs
    // the start the caller asked for.
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/bots?backendId=a-plain`, { headers: auth(gate) });
    assert.equal(response.status, 501);
    assert.equal((await response.json()).error.code, 'backend_unsupported');
    assert.deepEqual(started, ['a-plain']);
  } finally {
    await gate.close();
  }
});

test('a backend whose capability cannot be read is started and asked, as before', async () => {
  const calls = [];
  const started = [];
  const { gate } = await makeGate({
    calls,
    registry: mixedRosterRegistry(calls, { probeRefuses: true }),
    environments: MIXED_ROSTER,
    backendServerFactory: recordingServerFactory(started),
  });
  try {
    // `a-plain` answers with a known empty capability set; `b-capable` cannot be
    // probed at all, which is unknown rather than empty — so it starts, as it
    // always has, and the route is served.
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/bots`, { headers: auth(gate) });
    assert.equal(response.status, 200, `the capable backend should have answered (${started.join(', ')})`);
    assert.equal((await response.json()).data[0].id, 'researcher');
    assert.deepEqual(started, ['b-capable']);
  } finally {
    await gate.close();
  }
});

// ─── Detachable turns: a phone that locks mid-reply keeps the reply ─────
// Android suspends (and often kills) an app's socket when the screen locks,
// which is indistinguishable from the user pressing Stop. Reading it as the
// latter killed the turn: the reply was thrown away, and with it the only
// notification the phone would ever get for it.

const TURN_ID = 'turn-abc-123';

/** A turn whose send is held open by the test, recording the abort signal. */
function parkedTurnRegistry(turns, { delta } = {}) {
  // The runner subscribes and then sends with no await in between, so the feed
  // signal and the send of one turn are adjacent: a queue pairs them up even
  // with several turns in flight.
  const signals = [];
  return stubTurnRegistry({
    sendMessage: (_id, input) => new Promise((resolve) => {
      turns.push({ resolve, signal: signals.shift(), text: input?.text });
    }),
    streamEvents: (_id, onEvent, signal) => {
      signals.push(signal);
      // Text the turn has already said, so a test can prove it is not retracted.
      if (delta) onEvent({ type: 'message.delta', payload: { text: delta } });
      return new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', resolve, { once: true });
      });
    },
  });
}

const streamingTurn = (gate, { turnId, controller, text = 'say it once', sessionId = 'ses_1' } = {}) => fetch(
  `http://127.0.0.1:${gate.port}/v1/chat/completions`,
  {
    method: 'POST',
    headers: { ...auth(gate), ...(turnId ? { 'X-Versutus-Turn-Id': turnId } : {}) },
    signal: controller?.signal,
    body: JSON.stringify({
      backendId: 'stub-local', ...(sessionId ? { sessionId } : {}),
      messages: [{ role: 'user', content: text }], stream: true,
    }),
  },
);

const answer = (text) => ({ text, message: { role: 'assistant', content: [{ type: 'text', text }] } });

/** Bounded poll: the seams under test (push delivery, abort) are async. */
const until = async (predicate, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
};

test('a turn named by the phone survives a dropped socket and pushes its reply once', async () => {
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
  const { gate } = await makeGate({ registry: parkedTurnRegistry(turns), pushFetch });
  const base = `http://127.0.0.1:${gate.port}`;
  const controller = new AbortController();
  try {
    for (const [method, params] of [
      ['notifications.register', { expoPushToken: 'ExponentPushToken[phone]', platform: 'ios', timezone: 'UTC', deviceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }],
      ['notifications.preferences.set', { enabled: true, deviceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }],
    ]) {
      const rpc = await fetch(`${base}/v1/capabilities/rpc`, {
        method: 'POST', headers: auth(gate), body: JSON.stringify({ method, params }),
      });
      assert.equal(rpc.status, 200);
    }

    const pending = streamingTurn(gate, { turnId: TURN_ID, controller });
    assert.ok(await until(() => turns.length === 1), 'the turn never reached the backend');
    // The phone is backgrounded: the socket dies mid-turn, with no Stop.
    controller.abort();
    await pending.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(turns[0].signal?.aborted, false, 'a dropped socket must not cancel a named turn');

    // The Gate finishes the turn on its own, and the answer reaches the phone
    // as the push it can no longer be streamed.
    turns[0].resolve(answer('the whole answer'));
    assert.ok(await until(() => pushSends.length === 1), 'a detached turn that finished must still push');
    // The reply notice names the session, not the text: the phone reads the
    // transcript. What is being proven here is that the turn finished and was
    // reported AT ALL, which is what locking the phone used to prevent.
    assert.equal(pushSends[0].data.kind, 'reply');
    assert.equal(pushSends[0].data.sessionId, 'ses_1');

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(pushSends.length, 1, 'exactly one notice per turn');
  } finally {
    await gate.close();
  }
});

test('a turn with no id keeps the old meaning of a dropped socket: the turn stops', async () => {
  const turns = [];
  const { gate } = await makeGate({ registry: parkedTurnRegistry(turns) });
  const controller = new AbortController();
  try {
    const pending = streamingTurn(gate, { controller });
    assert.ok(await until(() => turns.length === 1));
    controller.abort();
    await pending.catch(() => undefined);
    assert.ok(
      await until(() => turns[0].signal?.aborted === true),
      'an unnamed turn must still be cancelled by a close',
    );
  } finally {
    await gate.close();
  }
});

test('a turn id the protocol cannot accept is ignored, as if none was sent', async () => {
  const turns = [];
  const { gate } = await makeGate({ registry: parkedTurnRegistry(turns) });
  const controller = new AbortController();
  try {
    const pending = streamingTurn(gate, { turnId: 'short', controller });
    assert.ok(await until(() => turns.length === 1));
    controller.abort();
    await pending.catch(() => undefined);
    assert.ok(
      await until(() => turns[0].signal?.aborted === true),
      'a malformed id must not buy a detached turn',
    );
  } finally {
    await gate.close();
  }
});

test('Stop is a request the Gate acts on, and only for the caller that owns the turn', async () => {
  const turns = [];
  const { gate, paired } = await makeGate({ registry: parkedTurnRegistry(turns), pairedDevices: ['phone-two'] });
  const base = `http://127.0.0.1:${gate.port}`;
  const controller = new AbortController();
  const cancel = (turnId, token = gate.token) => fetch(`${base}/v1/chat/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ turnId }),
  });
  try {
    const pending = streamingTurn(gate, { turnId: TURN_ID, controller });
    assert.ok(await until(() => turns.length === 1));

    // Another phone's Stop must not reach into this turn.
    const otherCaller = await cancel(TURN_ID, paired['phone-two']);
    assert.equal(otherCaller.status, 200);
    assert.deepEqual(await otherCaller.json(), { cancelled: false });
    assert.equal(turns[0].signal?.aborted, false, "one phone must never stop another phone's turn");

    const stranger = await cancel('turn-nobody-owns');
    assert.deepEqual(await stranger.json(), { cancelled: false });

    const stopped = await cancel(TURN_ID);
    assert.deepEqual(await stopped.json(), { cancelled: true });
    assert.ok(await until(() => turns[0].signal?.aborted === true), 'Stop must abort the turn it names');

    // The phone closes its own socket afterwards, as it always did.
    controller.abort();
    await pending.catch(() => undefined);
    // A stopped turn is gone: asking again finds nothing to cancel.
    assert.equal((await (await cancel(TURN_ID)).json()).cancelled, false);
  } finally {
    await gate.close();
  }
});

test('a stopped turn ends quietly, and is not reported as one that came back empty', async () => {
  // Stop is a request the Gate acts on while the stream is deliberately still
  // open, so this is the flow the cancel route exists for: the phone keeps
  // reading to [DONE] after asking. An abort comes back from the runner as a
  // turn with no content, which is exactly what `empty_turn` reports — and the
  // app raises that frame as a streamError before it checks its own abort
  // (assertChatStreamComplete), so the user who pressed Stop was told "The model
  // did not answer", with advice to pick another model, after any text it had
  // already been given.
  const turns = [];
  const { gate } = await makeGate({ registry: parkedTurnRegistry(turns, { delta: 'Partial reply' }) });
  const base = `http://127.0.0.1:${gate.port}`;
  try {
    // No abort signal: this client keeps its socket open, as the phone does
    // while it waits for the stream to end after Stop.
    const pending = streamingTurn(gate, { turnId: TURN_ID });
    assert.ok(await until(() => turns.length === 1), 'the turn never reached the backend');

    const stopped = await fetch(`${base}/v1/chat/cancel`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ turnId: TURN_ID }),
    });
    assert.deepEqual(await stopped.json(), { cancelled: true });
    assert.ok(await until(() => turns[0].signal?.aborted === true), 'Stop must abort the turn it names');

    // What the turn had already said stays, and nothing is added to it.
    assert.equal(await (await pending).text(), delta('Partial reply') + 'data: [DONE]\n\n');
  } finally {
    await gate.close();
  }
});

test('a turn id already in use is refused, and the turn that owns it stays stoppable', async () => {
  // The turn id is how Stop finds a turn, so the map entry is ownership of it.
  // A second turn claiming the same id used to take that entry: the first
  // turn's `finally` then deleted the second turn's entry, and the second turn
  // could not be stopped by anyone — not by its own phone, not by close().
  const turns = [];
  // A delta per turn so every accepted stream flushes its headers at once: a
  // turn that says nothing never flushes them, and a client waiting on them
  // would be waiting for the turn to end.
  const { gate } = await makeGate({ registry: parkedTurnRegistry(turns, { delta: 'thinking' }) });
  const base = `http://127.0.0.1:${gate.port}`;
  const cancel = (turnId) => fetch(`${base}/v1/chat/cancel`, {
    method: 'POST',
    headers: auth(gate),
    body: JSON.stringify({ turnId }),
  });
  try {
    const first = streamingTurn(gate, { turnId: TURN_ID });
    first.catch(() => undefined);
    assert.ok(await until(() => turns.length === 1), 'the turn never reached the backend');

    // Refused as a request, before any stream header: a 200 with an
    // `text/event-stream` body would read to the client as a second live turn.
    const second = await streamingTurn(gate, { turnId: TURN_ID });
    assert.equal(second.status, 409);
    assert.match(second.headers.get('content-type'), /application\/json/);
    assert.equal(second.headers.get('x-versutus-session-id'), null, 'no turn was opened to stream');
    assert.equal((await second.json()).error.code, 'turn_id_in_use');
    assert.equal(turns.length, 1, 'the refused turn must never reach the backend');

    // The turn that owns the id is still the one Stop reaches.
    assert.deepEqual(await (await cancel(TURN_ID)).json(), { cancelled: true });
    assert.ok(await until(() => turns[0].signal?.aborted === true), 'Stop must abort the turn it names');
    await first.catch(() => undefined);

    // And the id is free again once that turn has ended, so a client that
    // retries with it is served rather than refused forever.
    let reused = null;
    for (let attempt = 0; attempt < 100 && !reused; attempt += 1) {
      const attempt_ = await streamingTurn(gate, { turnId: TURN_ID });
      if (attempt_.status !== 409) reused = attempt_;
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(reused, 'a turn id must be usable again once the turn it named has ended');
    assert.deepEqual(await (await cancel(TURN_ID)).json(), { cancelled: true });
  } finally {
    await gate.close();
  }
});

test('Stop needs the Gate\'s own credential', async () => {
  const { gate } = await makeGate();
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: TURN_ID }),
    });
    assert.equal(response.status, 401);
  } finally {
    await gate.close();
  }
});

test('no more than eight turns may run unseen; the ninth is cancelled as before', async () => {
  const turns = [];
  const { gate } = await makeGate({ registry: parkedTurnRegistry(turns) });
  const controllers = Array.from({ length: 9 }, () => new AbortController());
  try {
    const pendings = controllers.map((controller, index) => streamingTurn(gate, {
      turnId: `turn-detached-${index}`, controller, text: `turn number ${index}`,
    }));
    pendings.forEach((pending) => pending.catch(() => undefined));
    assert.ok(await until(() => turns.length === 9), `only ${turns.length} of 9 turns started`);

    // One at a time, so which close crossed the cap is unambiguous. Which turn
    // each close belongs to is read back from the backend, not assumed: the
    // requests reach the Gate in whatever order the pool hands them out.
    for (let index = 0; index < controllers.length; index += 1) {
      controllers[index].abort();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const cancelled = turns.filter((turn) => turn.signal?.aborted).map((turn) => turn.text);
      assert.deepEqual(
        cancelled,
        index === 8 ? ['turn number 8'] : [],
        `after ${index + 1} detached turns, the cancelled set should be ${index === 8 ? "['turn number 8']" : 'empty'}`,
      );
    }
  } finally {
    await gate.close();
  }
});

test('a detached turn is reaped once it is older than the age bound', async () => {
  const turns = [];
  const { gate } = await makeGate({
    registry: parkedTurnRegistry(turns),
    gateOptions: { detachedTurnMaxMs: 40 },
  });
  const controller = new AbortController();
  try {
    const pending = streamingTurn(gate, { turnId: TURN_ID, controller });
    pending.catch(() => undefined);
    assert.ok(await until(() => turns.length === 1));
    controller.abort();
    assert.ok(
      await until(() => turns[0].signal?.aborted === true, 2000),
      'a turn nobody is watching must not be able to run forever',
    );
  } finally {
    await gate.close();
  }
});

test('closing the Gate ends the turns it is still holding', async () => {
  const turns = [];
  const { gate } = await makeGate({ registry: parkedTurnRegistry(turns) });
  const controller = new AbortController();
  const pending = streamingTurn(gate, { turnId: TURN_ID, controller });
  pending.catch(() => undefined);
  assert.ok(await until(() => turns.length === 1));
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(turns[0].signal?.aborted, false);
  // Without this, close() waits on the detached turn's request handler.
  await gate.close();
  assert.equal(turns[0].signal?.aborted, true, 'a restart is a named end for every live turn');
});

test('a streamed turn tells the phone which session it belongs to', async () => {
  const created = [];
  const plain = stubRegistry([]).get('stubcli');
  const adapter = {
    ...plain,
    createBackend() {
      return {
        ...plain.createBackend(),
        async createSession(input) {
          const id = `ses_created_${created.length + 1}`;
          created.push({ id, title: input?.title });
          return { ...SESSION, id };
        },
        async sendMessage() { return answer('ok'); },
      };
    },
  };
  const { gate } = await makeGate({ registry: { get: () => adapter, list: () => [adapter] } });
  try {
    // The Gate opened this session, so only the response header can say which:
    // the body is a stream of deltas, and there is no session_id in it.
    const opened = await streamingTurn(gate, { sessionId: null });
    await opened.text();
    assert.equal(created.length, 1, 'the turn named no session, so the Gate opened one');
    assert.equal(opened.headers.get('x-versutus-session-id'), 'ses_created_1');

    // A session the caller already holds is echoed back, not replaced.
    const supplied = await streamingTurn(gate, { sessionId: 'ses_existing' });
    await supplied.text();
    assert.equal(supplied.headers.get('x-versutus-session-id'), 'ses_existing');
    assert.equal(created.length, 1, 'a supplied session must not be reopened');
  } finally {
    await gate.close();
  }
});

// ─── A turn that is over must leave nothing armed ────────────────────────
// Node emits `close` after `finish`, so a turn that ran to its end on a live
// socket reaches the detach handler too. A turn that is over must not look like
// one that was detached: it would mark itself detached and arm an age timer
// nothing can ever clear, holding an AbortController for ten minutes a turn.

/** Watch the long timers the Gate arms, and prove the watch can see one. */
function trackLongTimers(thresholdMs) {
  const real = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  const live = new Map();
  let armed = 0;
  globalThis.setTimeout = (handler, delay, ...rest) => {
    const timer = real.set(handler, delay, ...rest);
    if (delay >= thresholdMs) {
      armed += 1;
      live.set(timer, delay);
    }
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    live.delete(timer);
    return real.clear(timer);
  };
  return {
    get armed() { return armed; },
    get pending() { return live.size; },
    restore() { globalThis.setTimeout = real.set; globalThis.clearTimeout = real.clear; },
  };
}

const DETACHED_AGE_MS = 30000;

/**
 * A turn over a connection that really closes.
 *
 * fetch keeps the socket in its pool, so the server's response never emits
 * `close` and the case under test never happens; a phone whose app is being
 * torn down does close. `agent: false` is that phone.
 */
function turnOverClosingConnection(gate, { turnId }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port: gate.port,
      path: '/v1/chat/completions',
      method: 'POST',
      agent: false,
      headers: { ...auth(gate), 'X-Versutus-Turn-Id': turnId, 'Content-Type': 'application/json' },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    request.end(JSON.stringify({
      backendId: 'stub-local', sessionId: 'ses_1',
      messages: [{ role: 'user', content: 'say it once' }], stream: true,
    }));
  });
}

test('a turn that finished on a live socket arms no timer to reap it', async () => {
  const plain = stubRegistry([]).get('stubcli');
  const adapter = {
    ...plain,
    createBackend() {
      return { ...plain.createBackend(), async sendMessage() { return answer('a full answer'); } };
    },
  };
  const { gate } = await makeGate({
    registry: { get: () => adapter, list: () => [adapter] },
    gateOptions: { detachedTurnMaxMs: DETACHED_AGE_MS },
  });
  const timers = trackLongTimers(DETACHED_AGE_MS / 2);
  try {
    const finished = await turnOverClosingConnection(gate, { turnId: TURN_ID });
    assert.equal(finished.status, 200);
    assert.match(finished.body, /a full answer/);
    // The socket is gone, so `close` has followed `finish` — which is when the
    // detach handler used to arm its timer on a turn that was already over.
    // (The next test is the other half: a close on an unfinished turn does arm
    // one, so a zero here is the fix and not a blind spot.)
    assert.equal(timers.pending, 0, `a finished turn armed ${timers.pending} reaper timer(s)`);
    assert.equal(timers.armed, 0, 'a turn nobody walked away from has nothing to reap');
  } finally {
    timers.restore();
    await gate.close();
  }
});

test('a detached turn does arm one, and the turn ending clears it', async () => {
  const turns = [];
  const { gate } = await makeGate({
    registry: parkedTurnRegistry(turns),
    gateOptions: { detachedTurnMaxMs: DETACHED_AGE_MS },
  });
  const timers = trackLongTimers(DETACHED_AGE_MS / 2);
  const controller = new AbortController();
  try {
    const pending = streamingTurn(gate, { turnId: TURN_ID, controller });
    pending.catch(() => undefined);
    assert.ok(await until(() => turns.length === 1));
    controller.abort();
    await pending.catch(() => undefined);
    // The watch is proved by this turn: it is the case that must arm one.
    assert.ok(await until(() => timers.armed > 0), 'a detached turn must be bounded by its age');
    assert.equal(timers.pending, 1);

    turns[0].resolve(answer('the whole answer'));
    assert.ok(
      await until(() => timers.pending === 0),
      'the timer must not outlive the turn it was reaping',
    );
  } finally {
    timers.restore();
    await gate.close();
  }
});

// ─── A delete the backend refuses ───────────────────────────────────────
// Both DELETE routes were unwrapped, so any refusal became a generic 500 with
// a logged stack: the phone could not tell "that is already gone" from "the
// Gate is broken", and had no code to branch on.

for (const [label, route, operation, fallbackCode, method] of [
  ['DELETE /v1/jobs/:id', '/v1/jobs/job-1', 'removeJob', 'job_delete_failed', 'DELETE'],
  ['DELETE /v1/sessions/:id', '/v1/sessions/ses_1', 'deleteSession', 'session_delete_failed', 'DELETE'],
]) {
  test(`${label} answers a backend refusal with a status and a code`, async () => {
    let failure = null;
    const calls = [];
    const registry = stubFrontedRegistry(calls);
    const adapter = registry.get('stubcli');
    const createBackend = adapter.createBackend.bind(adapter);
    adapter.createBackend = (...args) => ({
      ...createBackend(...args),
      async [operation](...input) {
        if (failure) throw failure;
        calls.push(`${operation}:${input[0]}`);
      },
    });
    const { gate } = await makeGate({ calls, registry });
    try {
      const send = () => fetch(`http://127.0.0.1:${gate.port}${route}?backendId=stub-local`, {
        method, headers: auth(gate),
      });

      // An upstream status in the 4xx/5xx band is the backend's own answer and
      // is passed through, as every sibling fronted route does.
      failure = Object.assign(new Error('Routine store refused'), { status: 503, code: 'job_busy' });
      const refused = await send();
      assert.equal(refused.status, 503);
      assert.match(refused.headers.get('content-type'), /application\/json/);
      assert.deepEqual(await refused.json(), { error: { message: 'Routine store refused', code: 'job_busy' } });

      // A refusal with no usable status is the Gate talking about its backend.
      failure = new Error('Hermes connection reset');
      const broken = await send();
      assert.equal(broken.status, 502);
      assert.deepEqual(await broken.json(), { error: { message: 'Hermes connection reset', code: fallbackCode } });

      // "It is already gone" is 404, named by what is missing, not a 502: the
      // phone deletes it locally either way and must not retry forever.
      failure = Object.assign(new Error('session not found'), { code: 'unknown_session' });
      const missing = await send();
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), { error: { message: 'session not found', code: 'unknown_session' } });

      // An out-of-band status is not passed through: a 200 refusal would read
      // as a successful delete.
      failure = Object.assign(new Error('Routine store unavailable'), { status: 200 });
      const invalid = await send();
      assert.equal(invalid.status, 502);
      assert.deepEqual(await invalid.json(), { error: { message: 'Routine store unavailable', code: fallbackCode } });

      failure = null;
      const success = await send();
      assert.equal(success.status, 200);
    } finally {
      await gate.close();
    }
  });
}

