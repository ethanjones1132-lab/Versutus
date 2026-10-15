import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';
import { DeviceTokenStore } from '../core/device-tokens.mjs';

// The shell learned to consult a grant's recorded scopes (`terminal:use`), but
// every route that spawns or mutates still answered any valid bearer token: a
// device paired with only `terminal:use` could start runs, send chat and create
// or delete sessions. A grant is the whole grant, so the acting routes now ask
// for the scope they need by name. Reads stay caller-scoped; the Gate's own
// token carries no device grant and stays the operator's unrestricted
// credential.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A CLI environment whose adapter and backend are entirely in-process. */
function stubRegistry(calls) {
  const backend = {
    async listSessions() { return []; },
    async createSession(input) {
      calls.push('createSession');
      return { id: 'ses_new', source: 'stubcli', title: input?.title ?? null };
    },
    async deleteSession(id) { calls.push(`deleteSession:${id}`); },
    async listMessages() { return []; },
    async sendMessage(id, { text }) {
      calls.push(`sendMessage:${id}`);
      return { text: `echo ${text}`, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: `echo ${text}` }] } };
    },
    async listModels() { return []; },
    async startRun() { calls.push('startRun'); return { run_id: 'stub-run-1', status: 'started' }; },
    async getRunStatus() { return { status: 'completed' }; },
    async stopRun(id) { calls.push(`stopRun:${id}`); },
    async replyApproval(id) { calls.push(`replyApproval:${id}`); },
    async abort() {},
    async streamEvents() {},
  };
  const adapter = {
    adapterId: 'stubcli',
    adapterRevision: '1',
    supportedCliVersions: '1.x',
    protocolVersions: { acp: '1' },
    capabilities: ['sessions', 'tools', 'models', 'runs'],
    server: { defaultPort: 1, healthPath: '/', args: () => [], portFromOutput: () => null },
    async probe() { return { state: 'ready', cliVersion: '1.0.0', protocol: 'acp' }; },
    createBackend: () => backend,
  };
  return {
    get(id) { if (id !== 'stubcli') throw new Error(`unknown CLI adapter "${id}"`); return adapter; },
    list() { return [adapter]; },
  };
}

/**
 * A real Gate whose device-token store already holds one grant per named
 * device, issued with exactly the scopes passed here — the same store
 * `cli.mjs pair approve` writes — and one in-process CLI environment.
 */
async function makeGate(scopesByDevice) {
  const root = await mkdtemp(join(tmpdir(), 'gate-scope-enforcement-'));
  roots.push(root);
  const gateHome = join(root, '.gate-home');
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
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

  const store = new DeviceTokenStore(join(root, '.device-tokens.json'));
  const tokens = {};
  for (const [deviceId, scopes] of Object.entries(scopesByDevice)) {
    tokens[deviceId] = await store.issue(deviceId, { role: 'operator', scopes });
  }

  const calls = [];
  const gate = await createGate({
    root,
    port: 0,
    gateHome,
    environmentRegistry: stubRegistry(calls),
    // The stub's "server" needs no process: report it as already reachable.
    backendServerFactory: () => ({
      ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:1', attached: true }),
      stop: async () => {},
      isOwned: () => false,
    }),
  });
  return { gate, tokens, calls };
}

function call(gate, path, token, { method = 'GET', body } = {}) {
  return fetch(`http://127.0.0.1:${gate.port}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `Bearer ${token}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('a grant holding only terminal:use cannot start a run', async () => {
  const { gate, tokens, calls } = await makeGate({
    'phone-narrow': ['terminal:use'],
    'phone-runner': ['runs:start'],
  });
  try {
    const refused = await call(gate, '/v1/runs', tokens['phone-narrow'], {
      method: 'POST',
      body: { input: 'do it', backendId: 'stub-local' },
    });
    assert.equal(refused.status, 403);
    const body = await refused.json();
    assert.equal(body.error.code, 'scope_required');
    assert.match(body.error.message, /runs:start/);
    assert.ok(!calls.includes('startRun'), 'the refused grant never reaches the backend');

    const started = await call(gate, '/v1/runs', tokens['phone-runner'], {
      method: 'POST',
      body: { input: 'do it', backendId: 'stub-local' },
    });
    assert.equal(started.status, 200);
    assert.ok(calls.includes('startRun'), 'the grant holding runs:start still starts a run');
  } finally {
    await gate.close();
  }
});

test('a refused grant cannot steer a run it can reach by handle', async () => {
  const { gate, tokens, calls } = await makeGate({
    'phone-narrow': ['terminal:use'],
    'phone-runner': ['runs:start'],
  });
  try {
    const started = await call(gate, '/v1/runs?backendId=stub-local', tokens['phone-runner'], {
      method: 'POST',
      body: { input: 'do it' },
    });
    assert.equal(started.status, 200);
    const handle = (await started.json()).run_id;
    assert.ok(handle, 'the runner got a usable run handle');

    for (const action of ['stop', 'approval']) {
      const refused = await call(
        gate,
        `/v1/runs/${encodeURIComponent(handle)}/${action}?backendId=stub-local`,
        tokens['phone-narrow'],
        { method: 'POST', body: {} },
      );
      assert.equal(refused.status, 403, `${action} must be refused before the run is touched`);
      assert.equal((await refused.json()).error.code, 'scope_required');
    }
    assert.ok(
      !calls.some((c) => c.startsWith('stopRun') || c.startsWith('replyApproval')),
      'the refused grant steers nothing',
    );

    const stopped = await call(
      gate,
      `/v1/runs/${encodeURIComponent(handle)}/stop?backendId=stub-local`,
      tokens['phone-runner'],
      { method: 'POST', body: {} },
    );
    assert.equal(stopped.status, 200);
    assert.ok(calls.some((c) => c.startsWith('stopRun')), 'the grant holding runs:start still stops the run');
  } finally {
    await gate.close();
  }
});

test('the environment run routes ask for runs:start too', async () => {
  const { gate, tokens } = await makeGate({
    'phone-narrow': ['terminal:use'],
    'phone-runner': ['runs:start'],
  });
  try {
    for (const path of [
      '/v1/environments/stub-local/runs',
      '/v1/environments/stub-local/runs/stub-run-1/cancel',
      '/v1/environments/stub-local/runs/stub-run-1/approve',
    ]) {
      const refused = await call(gate, path, tokens['phone-narrow'], { method: 'POST', body: {} });
      assert.equal(refused.status, 403, `${path} must be refused`);
      assert.equal((await refused.json()).error.code, 'scope_required');
    }

    // The grant holding the scope gets past the check: an environment that
    // does not exist is the route's own 409, never the scope refusal.
    const passed = await call(gate, '/v1/environments/nope/runs', tokens['phone-runner'], {
      method: 'POST',
      body: { input: 'go' },
    });
    assert.equal(passed.status, 409);
    assert.equal((await passed.json()).error.code, 'environment_not_found');
  } finally {
    await gate.close();
  }
});

test('a grant holding only terminal:use cannot send a chat turn', async () => {
  const { gate, tokens, calls } = await makeGate({
    'phone-narrow': ['terminal:use'],
    'phone-chatter': ['chat:send'],
  });
  try {
    for (const path of ['/v1/chat/completions', '/p/stub-local/v1/chat/completions']) {
      const refused = await call(gate, path, tokens['phone-narrow'], {
        method: 'POST',
        body: { backendId: 'stub-local', sessionId: 'ses_1', messages: [{ role: 'user', content: 'hi' }] },
      });
      assert.equal(refused.status, 403, `${path} must be refused`);
      const body = await refused.json();
      assert.equal(body.error.code, 'scope_required');
      assert.match(body.error.message, /chat:send/);
    }
    assert.ok(!calls.some((c) => c.startsWith('sendMessage')), 'no turn reaches the backend');

    const allowed = await call(gate, '/v1/chat/completions', tokens['phone-chatter'], {
      method: 'POST',
      body: { backendId: 'stub-local', sessionId: 'ses_1', messages: [{ role: 'user', content: 'ping' }] },
    });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).choices[0].message.content, 'echo ping');
  } finally {
    await gate.close();
  }
});

test('a grant holding only terminal:use cannot create or delete a session', async () => {
  const { gate, tokens, calls } = await makeGate({
    'phone-narrow': ['terminal:use'],
    'phone-sessions': ['sessions:manage'],
  });
  try {
    const refusedCreate = await call(gate, '/v1/sessions', tokens['phone-narrow'], {
      method: 'POST',
      body: { backendId: 'stub-local', title: 'From the narrow grant' },
    });
    assert.equal(refusedCreate.status, 403);
    const refusedBody = await refusedCreate.json();
    assert.equal(refusedBody.error.code, 'scope_required');
    assert.match(refusedBody.error.message, /sessions:manage/);

    const refusedDelete = await call(gate, '/v1/sessions/ses_1?backendId=stub-local', tokens['phone-narrow'], {
      method: 'DELETE',
    });
    assert.equal(refusedDelete.status, 403);
    assert.ok(!calls.some((c) => c.startsWith('deleteSession')), 'nothing was deleted');

    const created = await call(gate, '/v1/sessions', tokens['phone-sessions'], {
      method: 'POST',
      body: { backendId: 'stub-local', title: 'From the grant' },
    });
    assert.equal(created.status, 200);
    const deleted = await call(gate, '/v1/sessions/ses_1?backendId=stub-local', tokens['phone-sessions'], {
      method: 'DELETE',
    });
    assert.equal(deleted.status, 200);
    assert.ok(calls.includes('deleteSession:ses_1'));
  } finally {
    await gate.close();
  }
});

test('a grant that cannot act still reads', async () => {
  const { gate, tokens } = await makeGate({ 'phone-narrow': ['terminal:use'] });
  try {
    assert.equal((await call(gate, '/v1/models', tokens['phone-narrow'])).status, 200);
    assert.equal((await call(gate, '/v1/environments', tokens['phone-narrow'])).status, 200);
    assert.equal((await call(gate, '/v1/sessions?backendId=stub-local', tokens['phone-narrow'])).status, 200);
  } finally {
    await gate.close();
  }
});

test("the Gate's own token is not a device grant and keeps acting", async () => {
  const { gate } = await makeGate({});
  try {
    const started = await call(gate, '/v1/runs', gate.token, {
      method: 'POST',
      body: { input: 'go', backendId: 'stub-local' },
    });
    assert.equal(started.status, 200);

    const chat = await call(gate, '/v1/chat/completions', gate.token, {
      method: 'POST',
      body: { backendId: 'stub-local', sessionId: 'ses_1', messages: [{ role: 'user', content: 'ping' }] },
    });
    assert.equal(chat.status, 200);

    const created = await call(gate, '/v1/sessions', gate.token, {
      method: 'POST',
      body: { backendId: 'stub-local', title: 'Operator thread' },
    });
    assert.equal(created.status, 200);
  } finally {
    await gate.close();
  }
});

test("a grant holding the app's DEFAULT_SCOPES keeps every acting route", async () => {
  // src/lib/portal/access.ts:90 — the scopes a paired phone and
  // scripts/register-desktop-agent.mjs both ask for.
  const { gate, tokens } = await makeGate({
    'phone-default': ['chat:send', 'chat:read', 'runs:start', 'runs:read', 'terminal:use', 'sessions:manage'],
  });
  const token = tokens['phone-default'];
  try {
    const started = await call(gate, '/v1/runs', token, {
      method: 'POST',
      body: { input: 'go', backendId: 'stub-local' },
    });
    assert.equal(started.status, 200);

    const chat = await call(gate, '/v1/chat/completions', token, {
      method: 'POST',
      body: { backendId: 'stub-local', sessionId: 'ses_1', messages: [{ role: 'user', content: 'ping' }] },
    });
    assert.equal(chat.status, 200);

    const created = await call(gate, '/v1/sessions', token, {
      method: 'POST',
      body: { backendId: 'stub-local', title: 'Paired phone thread' },
    });
    assert.equal(created.status, 200);
    const deleted = await call(gate, '/v1/sessions/ses_1?backendId=stub-local', token, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
  } finally {
    await gate.close();
  }
});
