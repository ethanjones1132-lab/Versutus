import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';
import { DeviceTokenStore } from '../core/device-tokens.mjs';

// The Gate already knew how to push (the notifier) and already knew when a
// turn finishes (the chat route), but nothing introduced them:
// createPushNotifier had zero callers, so a completed turn never became a
// push even for an enabled device outside quiet hours. These tests drive a
// real turn through /v1/chat/completions after registering an enabled row
// the same way the app does, over the notifications RPC.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];
const deviceTokensFilename = '.device-tokens.json';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitFor(predicate, { ms = 4000, step = 25 } = {}) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, step));
  }
}

function gateStubUpstreamJson(messages) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { data: messages.map((message, index) => ({ status: 'ok', id: `ticket-${index}` })) };
    },
  };
}

function gateStubUpstreamReceipts(ids) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { data: Object.fromEntries(ids.map((id) => [id, { status: 'ok' }])) };
    },
  };
}

const session = (id) => ({
  id,
  started_at: 0,
  message_count: 0,
});

/** A Hermes-shaped backend: it inventories a Bot and answers a turn. */
function botsBackend(calls, state) {
  const forBot = (botId) => ({
    async listSessions() { return []; },
    async createSession() { return session('bot_new'); },
    async deleteSession() {},
    async listMessages() { return []; },
    async sendMessage() {
      calls.push('sendMessage');
      if (state.empty) return { text: '', message: null };
      return { text: 'planned', message: null };
    },
    async listModels() { return []; },
    async abort() {},
    async replyApproval() {},
    async streamEvents() {},
  });
  return {
    async listSessions() { return []; },
    async createSession() { return session('plain_new'); },
    async deleteSession() {},
    async listMessages() { return []; },
    async sendMessage() { return { text: 'plain answer', message: null }; },
    async listModels() { return []; },
    async abort() {},
    async replyApproval() {},
    async streamEvents() {},
    async listBots() { return { object: 'list', data: [{ id: 'default', displayName: 'default', routable: true }] }; },
    async forBot(botId) { return forBot(botId); },
  };
}

function registryFor(calls, state) {
  const backend = botsBackend(calls, state);
  const adapter = {
    adapterId: 'botscli',
    adapterRevision: '1',
    supportedCliVersions: '1.x',
    protocolVersions: { acp: '1' },
    capabilities: ['sessions', 'tools', 'models', 'bots'],
    server: { defaultPort: 1, healthPath: '/', args: () => [], portFromOutput: () => null },
    async probe() { return { state: 'ready', cliVersion: '1.0.0', protocol: 'acp' }; },
    createBackend: () => backend,
  };
  return {
    get(id) { if (id !== 'botscli') throw new Error(`unknown CLI adapter "${id}"`); return adapter; },
    list() { return [adapter]; },
  };
}

async function makeGate() {
  const calls = [];
  const turnState = { empty: false };
  const root = await mkdtemp(join(tmpdir(), 'gate-finalresp-'));
  roots.push(root);
  const gateHome = join(root, '.gate-home');
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });
  await writeFile(join(gateHome, 'config', 'environments', 'stub-local.json'), JSON.stringify({
    schemaVersion: 1, kind: 'cli-environment', id: 'stub-local', label: 'Stub',
    adapterId: 'botscli', executable: { path: 'C:\\stub.exe' }, protocolPreference: ['acp'],
    versionPolicy: { supported: '1.x', adapterRevision: '1' }, providerRefs: [],
    workspacePolicy: { roots: ['C:\\ws'], defaultRoot: 'C:\\ws', defaultSandbox: 'workspace_write', allowAdditionalRoots: false },
    lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 1 },
    enabled: true,
  }), 'utf8');

  const pushFetchCalls = [];
  const pushFetch = async (url, init) => {
    if (String(url).endsWith('/push/send')) {
      pushFetchCalls.push(JSON.parse(init.body));
      return gateStubUpstreamJson(JSON.parse(init.body));
    }
    return gateStubUpstreamReceipts(JSON.parse(init.body).ids);
  };

  const gate = await createGate({
    root,
    port: 0,
    gateHome,
    environmentRegistry: registryFor(calls, turnState),
    backendServerFactory: () => ({
      ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:1', attached: true }),
      stop: async () => {},
      isOwned: () => false,
    }),
    pushFetch,
  });
  return { gate, calls, turnState, pushFetchCalls };
}

const auth = (gate) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` });
const base = (gate) => `http://127.0.0.1:${gate.port}`;

async function rpc(gate, bearer, method, params) {
  return fetch(`${base(gate)}/v1/capabilities/rpc`, {
    method: 'POST',
    headers: { ...auth(gate), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify({ method, params }),
  });
}

async function pairAndEnable(gate, root, expoPushToken = 'ExponentPushToken[phone-row]') {
  const store = new DeviceTokenStore(join(root, deviceTokensFilename));
  const bearer = await store.issue('phone-grant', { role: 'operator', scopes: ['operator.read'] });
  // Exactly the app's own sequence: register the platform token, then opt in.
  const registered = await rpc(gate, bearer, 'notifications.register', {
    expoPushToken,
    platform: 'ios',
    timezone: 'UTC',
  });
  assert.equal(registered.status, 200);
  const response = await rpc(gate, bearer, 'notifications.preferences.set', { enabled: true });
  assert.equal(response.status, 200);
  return bearer;
}

async function sendTurn(gate, sessionId, botId = 'default') {
  return fetch(`${base(gate)}/v1/chat/completions`, {
    method: 'POST',
    headers: auth(gate),
    body: JSON.stringify({
      bot: botId,
      sessionId,
      model: 'opencode-go/ox-alpha-free',
      messages: [{ role: 'user', content: 'plan the launch' }],
    }),
  });
}

test('a completed backend turn sends exactly one contentless reply push to an enabled device', async () => {
  const { gate, calls, pushFetchCalls } = await makeGate();
  try {
    await pairAndEnable(gate, roots[roots.length - 1]);
    const response = await sendTurn(gate, 'bot_1');
    assert.equal(response.status, 200);
    assert.ok(calls.includes('sendMessage'));

    await waitFor(() => pushFetchCalls.length === 1);
    assert.equal(pushFetchCalls.length, 1, 'one turn, one push batch, no extra fetches');
    const [messages] = pushFetchCalls;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].to, 'ExponentPushToken[phone-row]');
    assert.equal(messages[0].title, "default finished a reply");
    assert.equal(messages[0].body, '', 'a reply push stays contentless until the device opts into rich bodies');
    assert.equal(messages[0].data.kind, 'reply');
    assert.equal(messages[0].data.sessionId, 'bot_1');
    assert.equal(messages[0].channelId, 'model-replies');
  } finally {
    await gate.close();
  }
});

test('a turn on a device whose row is disabled sends nothing', async () => {
  const { gate, pushFetchCalls } = await makeGate();
  try {
    // Register the device the app does (no Expo token), leave enabled false.
    const store = new DeviceTokenStore(join(roots[roots.length - 1], deviceTokensFilename));
    const bearer = await store.issue('phone-grant', { role: 'operator', scopes: ['operator.read'] });
    await rpc(gate, bearer, 'notifications.register', {
      expoPushToken: 'ExponentPushToken[plane-row]',
      platform: 'ios',
      timezone: 'UTC',
    });
    const response = await sendTurn(gate, 'bot_1');
    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(pushFetchCalls, []);
  } finally {
    await gate.close();
  }
});

test('a turn hitting the empty_turn 502 sends nothing', async () => {
  const { gate, calls, turnState, pushFetchCalls } = await makeGate();
  try {
    await pairAndEnable(gate, roots[roots.length - 1]);
    turnState.empty = true;
    const response = await sendTurn(gate, 'bot_1');
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'empty_turn');
    assert.ok(calls.includes('sendMessage'), 'the turn must still reach the backend');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(pushFetchCalls, []);
  } finally {
    await gate.close();
  }
});

test('a second turn pushes again — the dedupe is per transition, not per session lifetime', async () => {
  const { gate, pushFetchCalls } = await makeGate();
  try {
    await pairAndEnable(gate, roots[roots.length - 1]);
    await sendTurn(gate, 'bot_1');
    await waitFor(() => pushFetchCalls.length === 1);
    // Wait for the first turn's send to be fully traced before starting the
    // next one, so the assertion below is reading settled state.
    await sendTurn(gate, 'bot_2');
    await waitFor(() => pushFetchCalls.length === 2);
    assert.equal(pushFetchCalls[1][0].data.sessionId, 'bot_2');
  } finally {
    await gate.close();
  }
});

test('a cron session id reaches the tray as a routine, not as a reply', async () => {
  const { gate, pushFetchCalls } = await makeGate();
  try {
    await pairAndEnable(gate, roots[roots.length - 1]);
    const response = await sendTurn(gate, 'cron_scout_20260914_090000');
    assert.equal(response.status, 200);
    await waitFor(() => pushFetchCalls.length === 1);
    assert.equal(pushFetchCalls[0][0].data.kind, 'routine');
    assert.equal(pushFetchCalls[0][0].data.jobId, 'scout');
    assert.equal(pushFetchCalls[0][0].channelId, 'routine-results');
  } finally {
    await gate.close();
  }
});

test('a turn that names a Bot carries that Bot into the push data', async () => {
  const { gate, calls, turnState, pushFetchCalls } = await makeGate();
  void calls;
  void turnState;
  try {
    await pairAndEnable(gate, roots[roots.length - 1]);
    const response = await sendTurn(gate, 'bot_1');
    assert.equal(response.status, 200);
    await waitFor(() => pushFetchCalls.length === 1);
    assert.equal(pushFetchCalls[0][0].data.botId, 'default');
  } finally {
    await gate.close();
  }
});
