import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';
import { DeviceTokenStore } from '../core/device-tokens.mjs';
import { validEnvironment } from './fixtures/cli-environment.mjs';

// The shell learned to consult a grant's recorded scopes (`terminal:use`), but
// every route that spawns or mutates still answered any valid bearer token: a
// device paired with only `terminal:use` could start runs, send chat and create
// or delete sessions. A grant is the whole grant, so the acting routes now ask
// for the scope they need by name. Reads stay caller-scoped; the Gate's own
// token carries no device grant and stays the operator's unrestricted
// credential.
//
// The acting RPC methods answered that token the same way after the routes were
// gated: a grant paired for the shell alone could still register and delete
// providers, add environments, run routines and write capability secrets. An
// RPC method is named in the body rather than the path, so the Gate's own
// method tables now ask by name too, and the app's DEFAULT_SCOPES names every
// surface the app carries.
//
// The Bot, room and routine routes were the last acting REST surfaces answering
// that token: a grant paired for the shell alone could create and edit Bots,
// hand a mention to one, create, rename, leave and disband rooms, send the
// message that makes every member speak, and create, run, pause and delete
// routines. Those routes ask for bots:manage and routines:manage now — the two
// scopes the app's grant already names for its New Agent sheet, group chat and
// Routines pane.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const agentKindModulePath = fileURLToPath(new URL('../core/capabilities/agent/kind.mjs', import.meta.url));
const roots = [];

// src/lib/portal/access.ts:90 — the scopes a fresh pairing asks for. Spelled
// out here as the app sends them: a scope the app stops asking for, or one the
// Gate starts asking for without the app naming it, fails the last test.
const APP_DEFAULT_SCOPES = [
  'chat:send', 'chat:read', 'runs:start', 'runs:read', 'terminal:use', 'sessions:manage',
  'providers:manage', 'environments:manage', 'routines:manage', 'capabilities:manage',
  'devices:manage', 'voice:manage', 'bots:manage',
];

// The registration manifest-provider-merge.test.mjs uses: a complete api_key
// provider, so a refused call is refused by the scope check and not by schema.
const PROVIDER_REGISTRATION = {
  schemaVersion: 2,
  kind: 'provider',
  id: 'acme',
  label: 'Acme',
  providerType: 'openai',
  enabled: true,
  registration: {
    mode: 'api_key',
    protocol: 'openai_chat',
    baseUrl: 'https://api.openai.com/v1',
    credentialRef: 'provider/acme/api-key',
  },
  catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
  requestPolicy: { timeoutMs: 120000 },
};

// Every acting method on the Gate's own RPC tables, with params valid enough
// that the handler (not this list) would have to refuse anything the scope
// check lets through.
const RPC_ACTIONS = [
  ['providers.create', PROVIDER_REGISTRATION, 'providers:manage'],
  ['providers.update', { id: 'acme', label: 'Renamed' }, 'providers:manage'],
  ['providers.delete', { id: 'acme' }, 'providers:manage'],
  ['providers.health.check', { id: 'acme' }, 'providers:manage'],
  ['providers.catalog.refresh', { id: 'acme' }, 'providers:manage'],
  ['providers.auth.setApiKey', { id: 'acme', value: 'sk-live-refused' }, 'providers:manage'],
  ['providers.auth.begin', { id: 'acme' }, 'providers:manage'],
  ['providers.auth.disconnect', { id: 'acme' }, 'providers:manage'],
  ['environments.create', validEnvironment({ id: 'rpc-created' }), 'environments:manage'],
  ['environments.update', { id: 'stub-local', label: 'Renamed' }, 'environments:manage'],
  ['environments.delete', { id: 'stub-local' }, 'environments:manage'],
  ['environments.check', { id: 'stub-local' }, 'environments:manage'],
  ['environments.lifecycle.start', { id: 'stub-local' }, 'environments:manage'],
  ['environments.lifecycle.stop', { id: 'stub-local' }, 'environments:manage'],
  ['jobs.create', { name: 'Nightly', prompt: 'Do it', schedule: '0 3 * * *' }, 'routines:manage'],
  ['jobs.run', { jobId: 'job-1' }, 'routines:manage'],
  ['jobs.pause', { jobId: 'job-1' }, 'routines:manage'],
  ['jobs.resume', { jobId: 'job-1' }, 'routines:manage'],
  ['jobs.remove', { jobId: 'job-1' }, 'routines:manage'],
  ['registry.instances.create', { id: 'rpc-instance', kind: 'agent', label: 'RPC', config: { endpoint: 'https://agent.example' } }, 'capabilities:manage'],
  ['registry.instances.update', { id: 'stub-local', label: 'Renamed' }, 'capabilities:manage'],
  ['registry.instances.delete', { id: 'stub-local' }, 'capabilities:manage'],
  ['registry.secrets.set', { refName: 'STUB_KEY', value: 'secret-value' }, 'capabilities:manage'],
  ['device.revoke', { deviceId: 'ghost' }, 'devices:manage'],
  ['voice.install.start', {}, 'voice:manage'],
  ['voice.session.start', { thread: { sessionId: 'ses_1' } }, 'voice:manage'],
  ['voice.session.stop', { voiceSessionId: 'voice-1' }, 'voice:manage'],
  ['bots.memory.write', { id: 'researcher', name: 'MEMORY.md', text: 'x' }, 'bots:manage'],
  ['approval.approve', { approvalId: 'a1' }, 'runs:start'],
  ['approval.deny', { approvalId: 'a1' }, 'runs:start'],
];

// Every Bot, room and routine act the REST routes front, with the scope each
// one now asks for and params the routes could act on. The New Agent sheet
// (POST/PATCH /v1/bots, handoff), the group panes (create, rename, leave,
// disband, the message that makes every member speak) and the Routines pane
// (create, run, pause, resume, delete) are the app's own callers.
const BOT_AND_ROUTINE_ACTIONS = [
  ['POST', '/v1/bots', { name: 'researcher' }, 'bots:manage'],
  ['PATCH', '/v1/bots/researcher', { description: 'Reads the docs' }, 'bots:manage'],
  ['POST', '/v1/bots/handoff', { fromId: 'researcher', toId: 'writer', text: 'take this' }, 'bots:manage'],
  ['POST', '/v1/bot-groups', { name: 'crew', memberIds: ['researcher', 'writer'] }, 'bots:manage'],
  ['PATCH', '/v1/bot-groups/room-1', { name: 'bridge crew' }, 'bots:manage'],
  ['DELETE', '/v1/bot-groups/room-1', undefined, 'bots:manage'],
  ['POST', '/v1/bot-groups/room-1/leave', { memberId: 'researcher' }, 'bots:manage'],
  ['POST', '/v1/bot-groups/room-1/messages', { text: 'status?' }, 'bots:manage'],
  ['POST', '/v1/jobs', { name: 'Nightly', prompt: 'Do it', schedule: '0 3 * * *' }, 'routines:manage'],
  ['POST', '/v1/jobs/job-1/run', {}, 'routines:manage'],
  ['POST', '/v1/jobs/job-1/pause', {}, 'routines:manage'],
  ['POST', '/v1/jobs/job-1/resume', {}, 'routines:manage'],
  ['DELETE', '/v1/jobs/job-1', undefined, 'routines:manage'],
];

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
    async runJob(id) { calls.push(`runJob:${id}`); return { ok: true }; },
    async stopRun(id) { calls.push(`stopRun:${id}`); },
    async replyApproval(id) { calls.push(`replyApproval:${id}`); },
    // The Bot, room and routine surfaces the REST routes front.
    async listBots() { return { object: 'list', data: [{ id: 'researcher' }, { id: 'writer' }, { id: 'editor' }] }; },
    async getBot({ id }) { calls.push(`getBot:${id}`); return { id, name: id }; },
    async createBot({ name }) { calls.push(`createBot:${name}`); return { id: name, name }; },
    async updateBot({ id }) { calls.push(`updateBot:${id}`); return { id, name: id }; },
    async handoffMention({ toId }) { calls.push(`handoffMention:${toId}`); return { ok: true }; },
    async createJob({ name }) { calls.push(`createJob:${name}`); return { id: 'job-1', name }; },
    async listJobs() { return []; },
    async setJobPaused(id, paused) { calls.push(`setJobPaused:${id}:${paused}`); return { ok: true }; },
    async removeJob(id) { calls.push(`removeJob:${id}`); },
    async deliverGroupMessage({ name }) {
      calls.push(`deliverGroupMessage:${name}`);
      return { replies: [{ botId: 'researcher', text: 'on it' }] };
    },
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
  // The agent kind carries no handlers, but it is a loadable kind, so the
  // registry can be asked to create (and refuse to create) one.
  await mkdir(join(root, 'core', 'capabilities', 'agent'), { recursive: true });
  await copyFile(agentKindModulePath, join(root, 'core', 'capabilities', 'agent', 'kind.mjs'));
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

function rpcCall(gate, method, params, token) {
  return call(gate, '/v1/capabilities/rpc', token, { method: 'POST', body: { method, params } });
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

test('a grant holding only terminal:use cannot provision Bots or rooms, or run routines', async () => {
  const { gate, tokens, calls } = await makeGate({ 'phone-narrow': ['terminal:use'] });
  try {
    for (const [method, path, body, scope] of BOT_AND_ROUTINE_ACTIONS) {
      const refused = await call(gate, path, tokens['phone-narrow'], { method, body });
      assert.equal(refused.status, 403, `${method} ${path} must be refused`);
      const payload = await refused.json();
      assert.equal(payload.error.code, 'scope_required', `${method} ${path} must carry the scope refusal`);
      assert.match(payload.error.message, new RegExp(scope), `${method} ${path} must name ${scope}`);
    }
    assert.deepEqual(calls, [], 'no refused Bot, room or routine act reached the backend');
  } finally {
    await gate.close();
  }
});

test('a grant holding bots:manage still keeps Agent and group work', async () => {
  const { gate, tokens, calls } = await makeGate({ 'phone-bots': ['bots:manage'] });
  const token = tokens['phone-bots'];
  try {
    const created = await call(gate, '/v1/bots', token, {
      method: 'POST',
      body: { name: 'researcher' },
    });
    assert.equal(created.status, 200, 'the New Agent sheet still creates a Bot');
    assert.ok(calls.includes('createBot:researcher'), 'the Bot reaches the backend');

    const edited = await call(gate, '/v1/bots/researcher', token, {
      method: 'PATCH',
      body: { description: 'Reads the docs' },
    });
    assert.equal(edited.status, 200, 'a Bot still takes an edit');
    assert.ok(calls.includes('updateBot:researcher'));

    const handed = await call(gate, '/v1/bots/handoff', token, {
      method: 'POST',
      body: { fromId: 'researcher', toId: 'writer', text: 'take this' },
    });
    assert.equal(handed.status, 200, 'a mention still hands work to another Bot');
    assert.ok(calls.includes('handoffMention:writer'));

    const room = await call(gate, '/v1/bot-groups', token, {
      method: 'POST',
      body: { name: 'crew', memberIds: ['researcher', 'writer', 'editor'] },
    });
    assert.equal(room.status, 200, 'the group panes still create a room');
    const groupId = (await room.json()).id;

    const renamed = await call(gate, `/v1/bot-groups/${encodeURIComponent(groupId)}`, token, {
      method: 'PATCH',
      body: { name: 'bridge crew' },
    });
    assert.equal(renamed.status, 200, 'a room still takes a rename');

    const sent = await call(gate, `/v1/bot-groups/${encodeURIComponent(groupId)}/messages`, token, {
      method: 'POST',
      body: { text: 'status?' },
    });
    assert.equal(sent.status, 200, 'group chat still makes every member speak');
    assert.ok(calls.includes('deliverGroupMessage:bridge crew'));

    const left = await call(gate, `/v1/bot-groups/${encodeURIComponent(groupId)}/leave`, token, {
      method: 'POST',
      body: { memberId: 'editor' },
    });
    assert.equal(left.status, 200, 'a member still leaves a room');
    assert.deepEqual((await left.json()).memberIds, ['researcher', 'writer']);

    const disbanded = await call(gate, `/v1/bot-groups/${encodeURIComponent(groupId)}`, token, {
      method: 'DELETE',
    });
    assert.equal(disbanded.status, 200, 'a room still disbands');
  } finally {
    await gate.close();
  }
});

test('a grant holding routines:manage still keeps the Routines pane', async () => {
  const { gate, tokens, calls } = await makeGate({ 'phone-routines': ['routines:manage'] });
  const token = tokens['phone-routines'];
  try {
    const created = await call(gate, '/v1/jobs', token, {
      method: 'POST',
      body: { name: 'Nightly', prompt: 'Do it', schedule: '0 3 * * *' },
    });
    assert.equal(created.status, 200, 'the Routines pane still creates a routine');
    const jobId = (await created.json()).id;
    assert.ok(calls.includes('createJob:Nightly'));

    for (const verb of ['run', 'pause', 'resume']) {
      const answered = await call(gate, `/v1/jobs/${encodeURIComponent(jobId)}/${verb}`, token, {
        method: 'POST',
        body: {},
      });
      assert.equal(answered.status, 200, `the Routines pane still ${verb}s a routine`);
    }
    assert.ok(calls.includes(`runJob:${jobId}`), 'the run reaches the backend');
    assert.ok(calls.includes(`setJobPaused:${jobId}:true`), 'the pause reaches the backend');
    assert.ok(calls.includes(`setJobPaused:${jobId}:false`), 'the resume reaches the backend');

    const removed = await call(gate, `/v1/jobs/${encodeURIComponent(jobId)}`, token, { method: 'DELETE' });
    assert.equal(removed.status, 200, 'the Routines pane still deletes a routine');
    assert.ok(calls.includes(`removeJob:${jobId}`));
  } finally {
    await gate.close();
  }
});

test('a grant holding only terminal:use cannot act through the RPC surface', async () => {
  const { gate, tokens, calls } = await makeGate({ 'phone-narrow': ['terminal:use'] });
  try {
    for (const [method, params, scope] of RPC_ACTIONS) {
      const refused = await rpcCall(gate, method, params, tokens['phone-narrow']);
      assert.equal(refused.status, 403, `${method} must be refused`);
      const body = await refused.json();
      assert.equal(body.error.code, 'scope_required', `${method} must carry the scope refusal`);
      assert.match(body.error.message, new RegExp(scope), `${method} must name ${scope}`);
    }
    assert.deepEqual(calls, [], 'no refused RPC method reached the backend');
  } finally {
    await gate.close();
  }
});

test('a grant holding the manage scopes still acts through the RPC surface', async () => {
  const { gate, tokens, calls } = await makeGate({
    'phone-manager': ['providers:manage', 'environments:manage', 'routines:manage', 'capabilities:manage'],
  });
  const token = tokens['phone-manager'];
  try {
    const created = await rpcCall(gate, 'providers.create', PROVIDER_REGISTRATION, token);
    assert.equal(created.status, 200);
    const listed = await (await rpcCall(gate, 'providers.list', {}, token)).json();
    assert.ok(listed.result.providers.some((provider) => provider.id === 'acme'), 'the provider is listed');

    const removed = await rpcCall(gate, 'providers.delete', { id: 'acme' }, token);
    assert.equal(removed.status, 200);
    const after = await (await rpcCall(gate, 'providers.list', {}, token)).json();
    assert.deepEqual(after.result.providers, [], 'the grant holding providers:manage still deletes a provider');

    const ran = await rpcCall(gate, 'jobs.run', { jobId: 'job-1' }, token);
    assert.equal(ran.status, 200);
    assert.ok(calls.includes('runJob:job-1'), 'the grant holding routines:manage still runs a routine');

    const deleted = await rpcCall(gate, 'environments.delete', { id: 'stub-local' }, token);
    assert.equal(deleted.status, 200);
    const environments = await (await rpcCall(gate, 'environments.list', {}, token)).json();
    assert.deepEqual(environments.result.environments, [], 'the grant holding environments:manage still removes one');

    const added = await rpcCall(gate, 'registry.instances.create', {
      id: 'rpc-agent',
      kind: 'agent',
      label: 'RPC agent',
      config: { endpoint: 'https://agent.example' },
    }, token);
    assert.equal(added.status, 200);
    const instances = await (await rpcCall(gate, 'registry.instances.list', {}, token)).json();
    assert.ok(
      instances.result.some((instance) => instance.id === 'rpc-agent'),
      'the grant holding capabilities:manage still adds a capability',
    );
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
    // The Bot, room and routine reads are not in the acting table either: a
    // grant that cannot provision a Bot still sees the roster, a room, a
    // routine and one Bot's own page.
    assert.equal((await call(gate, '/v1/bots', tokens['phone-narrow'])).status, 200);
    assert.equal((await call(gate, '/v1/bots/researcher', tokens['phone-narrow'])).status, 200);
    assert.equal((await call(gate, '/v1/bot-groups', tokens['phone-narrow'])).status, 200);
    assert.equal((await call(gate, '/v1/jobs', tokens['phone-narrow'])).status, 200);
    // The RPC reads are not in the acting tables either.
    for (const method of ['providers.list', 'environments.list', 'registry.instances.list', 'device.list']) {
      assert.equal((await rpcCall(gate, method, {}, tokens['phone-narrow'])).status, 200, `${method} must keep reading`);
    }
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

test("a grant holding the app's DEFAULT_SCOPES keeps every acting route and RPC method", async () => {
  const { gate, tokens, calls } = await makeGate({ 'phone-default': APP_DEFAULT_SCOPES });
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

    // The RPC surface asks by method name; the app's grant names those too.
    assert.equal((await rpcCall(gate, 'jobs.run', { jobId: 'job-1' }, token)).status, 200);
    assert.ok(calls.includes('runJob:job-1'), 'the app grant still runs a routine');
    // The Bot, room and routine REST surfaces the New Agent sheet, group chat
    // and the Routines pane call.
    const agent = await call(gate, '/v1/bots', token, { method: 'POST', body: { name: 'researcher' } });
    assert.equal(agent.status, 200, 'the app grant still creates an Agent');
    const routine = await call(gate, '/v1/jobs', token, {
      method: 'POST',
      body: { name: 'Nightly', prompt: 'Do it', schedule: '0 3 * * *' },
    });
    assert.equal(routine.status, 200, 'the app grant still creates a routine');
    const room = await call(gate, '/v1/bot-groups', token, {
      method: 'POST',
      body: { name: 'crew', memberIds: ['researcher', 'writer'] },
    });
    assert.equal(room.status, 200, 'the app grant still creates a room');
    const added = await rpcCall(gate, 'registry.instances.create', {
      id: 'rpc-agent',
      kind: 'agent',
      label: 'RPC agent',
      config: { endpoint: 'https://agent.example' },
    }, token);
    assert.equal(added.status, 200, 'the app grant still adds a capability');
    const approval = await rpcCall(gate, 'approval.approve', { approvalId: 'a1' }, token);
    assert.equal(approval.status, 404, 'the app grant clears the scope check and reaches the approval store');
    // Last: removing the environment is the one call no later read needs.
    assert.equal((await rpcCall(gate, 'environments.delete', { id: 'stub-local' }, token)).status, 200);
  } finally {
    await gate.close();
  }
});
