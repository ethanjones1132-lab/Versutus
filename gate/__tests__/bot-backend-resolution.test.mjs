import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';

// A Gate usually fronts several CLI environments, and only one of them —
// Hermes — knows what a Bot is. The route that answers "give me this Bot's
// sessions" must therefore pick the environment by capability whenever the
// caller names none, exactly as /v1/bots and /v1/runs already do. Resolving
// to whichever environment happens to sort first answered every Bot request
// with 501 "This backend does not implement bots" on a Gate that had Bots.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const session = (id, source) => ({
  id, source, user_id: null, model: null, title: 'Session',
  started_at: 1, ended_at: null, end_reason: null, message_count: 0, tool_call_count: 0,
  input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
  reasoning_tokens: 0, estimated_cost_usd: null, actual_cost_usd: null, api_call_count: 0,
  parent_session_id: null, last_active: 1, preview: null, has_system_prompt: false,
  has_model_config: false,
});

/** A backend with no idea what a Bot is — Claude Code, Codex, OpenCode. */
function plainBackend(calls = []) {
  return {
    async listSessions(limit) { calls.push(`plainListSessions:${limit}`); return [session('plain_1', 'plaincli')]; },
    async createSession() { return session('plain_new', 'plaincli'); },
    async deleteSession() {},
    async listMessages() { return [{ id: 'p1', role: 'user', content: [{ type: 'text', text: 'plain' }], timestamp: 1 }]; },
    async sendMessage() { return { text: '', message: null }; },
    async listModels() { return []; },
    async abort() {},
    async replyApproval() {},
    async streamEvents() {},
  };
}

/** A Hermes-shaped backend: it inventories Bots and can scope itself to one. */
function botsBackend(calls) {
  const forBot = (botId) => ({
    async listSessions(limit) { calls.push(`listSessions:${botId}:${limit}`); return [session('bot_1', 'api_server')]; },
    async createSession(input) {
      calls.push(`createSession:${botId}`);
      if (input?.title === 'Taken') {
        const error = new Error('hermes: Title already in use by session api_1');
        error.status = 400;
        throw error;
      }
      return { ...session('bot_new', 'api_server'), title: input?.title ?? null };
    },
    async deleteSession() {},
    async listMessages(id) { calls.push(`listMessages:${botId}:${id}`); return []; },
    async sendMessage(id, input) {
      calls.push(`sendMessage:${botId}`);
      return { text: 'ok', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, runtime: { model: input?.model?.modelId } };
    },
    async listModels() { return []; },
    async abort() {},
    async replyApproval() {},
    async streamEvents() {},
  });
  return {
    ...plainBackend(calls),
    async listBots() { calls.push('listBots'); return { object: 'list', data: [{ id: 'default', displayName: 'default', routable: true }] }; },
    async forBot(botId) {
      if (botId !== 'default') {
        const error = new Error(`unknown bot "${botId}"`);
        error.code = 'unknown_bot';
        throw error;
      }
      return forBot(botId);
    },
  };
}

function registryFor(calls) {
  const make = (adapterId, capabilities, backend) => ({
    adapterId,
    adapterRevision: '1',
    supportedCliVersions: '1.x',
    protocolVersions: { acp: '1' },
    capabilities,
    server: { defaultPort: 1, healthPath: '/', args: () => [], portFromOutput: () => null },
    async probe() { return { state: 'ready', cliVersion: '1.0.0', protocol: 'acp' }; },
    createBackend: () => backend,
  });
  const adapters = [
    make('plaincli', ['sessions', 'tools', 'models'], plainBackend(calls)),
    make('botscli', ['sessions', 'tools', 'models', 'bots'], botsBackend(calls)),
  ];
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
    schemaVersion: 1, kind: 'cli-environment', id, label: id,
    adapterId, executable: { path: 'C:\\stub.exe' }, protocolPreference: ['acp'],
    versionPolicy: { supported: '1.x', adapterRevision: '1' }, providerRefs: [],
    workspacePolicy: { roots: ['C:\\ws'], defaultRoot: 'C:\\ws', defaultSandbox: 'workspace_write', allowAdditionalRoots: false },
    lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 1 },
    enabled: true,
  }), 'utf8');
}

async function makeGate() {
  const calls = [];
  const root = await mkdtemp(join(tmpdir(), 'gate-botres-'));
  roots.push(root);
  const gateHome = join(root, '.gate-home');
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });
  // "aaa" sorts first on purpose: it is the environment the old code always
  // picked, and the one that cannot serve a Bot.
  await environmentFile(gateHome, 'aaa-plain', 'plaincli');
  await environmentFile(gateHome, 'zzz-bots', 'botscli');

  const gate = await createGate({
    root,
    port: 0,
    gateHome,
    environmentRegistry: registryFor(calls),
    backendServerFactory: () => ({
      ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:1', attached: true }),
      stop: async () => {},
      isOwned: () => false,
    }),
  });
  return { gate, calls };
}

const auth = (gate) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` });
const base = (gate) => `http://127.0.0.1:${gate.port}`;

test('a Bot\'s sessions resolve to the environment that has Bots, not the first one', async () => {
  const { gate, calls } = await makeGate();
  try {
    const response = await fetch(`${base(gate)}/v1/sessions?bot=default&limit=20`, { headers: auth(gate) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data[0].id, 'bot_1');
    assert.ok(calls.some((entry) => entry.startsWith('listSessions:default')));
  } finally {
    await gate.close();
  }
});

test('a Bot\'s history resolves the same way', async () => {
  const { gate, calls } = await makeGate();
  try {
    const response = await fetch(`${base(gate)}/v1/sessions/bot_1/messages?bot=default&limit=20`, { headers: auth(gate) });
    assert.equal(response.status, 200);
    assert.ok(calls.includes('listMessages:default:bot_1'));
  } finally {
    await gate.close();
  }
});

test('creating a Bot session resolves the same way', async () => {
  const { gate, calls } = await makeGate();
  try {
    const response = await fetch(`${base(gate)}/v1/sessions?bot=default`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ title: 'Bot Chat' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.id, 'bot_new');
    assert.ok(calls.includes('createSession:default'));
  } finally {
    await gate.close();
  }
});

test('naming an environment that cannot serve Bots is still refused, not silently rerouted', async () => {
  // An explicit pin stays a pin: a caller that says "this environment" must
  // hear that it cannot do the job rather than have the Gate quietly answer
  // from somewhere else.
  const { gate } = await makeGate();
  try {
    const response = await fetch(`${base(gate)}/v1/sessions?bot=default&backendId=aaa-plain`, { headers: auth(gate) });
    assert.equal(response.status, 501);
    const body = await response.json();
    assert.match(body.error.message, /does not implement bots/i);
  } finally {
    await gate.close();
  }
});

test('a plain conversation still uses the first environment when no Bot is named', async () => {
  const { gate } = await makeGate();
  try {
    const response = await fetch(`${base(gate)}/v1/sessions?limit=20`, { headers: auth(gate) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data[0].id, 'plain_1', 'no bot named means no capability steering');
  } finally {
    await gate.close();
  }
});

test('an unknown Bot is a 404 from the environment that actually has Bots', async () => {
  const { gate } = await makeGate();
  try {
    const response = await fetch(`${base(gate)}/v1/sessions?bot=nobody`, { headers: auth(gate) });
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error.code, 'unknown_bot');
  } finally {
    await gate.close();
  }
});

test("the caller's session limit reaches the backend instead of dying at the Gate", async () => {
  // Slicing at the Gate cannot recover rows the backend never returned:
  // Hermes answers /api/sessions with its own default page, so asking for 200
  // silently meant 50 — and a Bot Chat older than that window looked absent.
  // The app then tried to create a second one and Hermes refused the title.
  const { gate, calls } = await makeGate();
  try {
    const response = await fetch(`${base(gate)}/v1/sessions?bot=default&limit=200`, { headers: auth(gate) });
    assert.equal(response.status, 200);
    assert.ok(calls.includes('listSessions:default:200'), `limit never reached the backend: ${calls.join(', ')}`);
  } finally {
    await gate.close();
  }
});

test('a backend refusing to create a session answers with its own status, not 500', async () => {
  const { gate } = await makeGate();
  try {
    const response = await fetch(`${base(gate)}/v1/sessions?bot=default`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ title: 'Taken' }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error.message, /already in use/i);
  } finally {
    await gate.close();
  }
});

test('a Bot turn reaches that Bot\'s environment even with no backendId named', async () => {
  // Naming a Bot is naming an environment. The chat route used to enter the
  // backend path only on `backendId`, so once the app stopped pinning the
  // thread's backend for Bot turns (correct — a Bot owns its own environment)
  // every Bot message fell through to the *provider proxy* instead, and came
  // back as "chat failed: 503 upstream_error" from a vendor that was never
  // meant to serve it.
  const { gate, calls } = await makeGate();
  try {
    const response = await fetch(`${base(gate)}/v1/chat/completions`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ bot: 'default', messages: [{ role: 'user', content: 'ping' }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'ok');
    assert.ok(calls.some((entry) => entry.startsWith('sendMessage:default')), `never reached the Bot: ${calls.join(', ')}`);
  } finally {
    await gate.close();
  }
});

test('a turn naming neither a backend nor a Bot still uses the provider path', async () => {
  // The provider proxy is the right home for an unscoped turn; this guards
  // the fix from swallowing it.
  const { gate, calls } = await makeGate();
  try {
    const response = await fetch(`${base(gate)}/v1/chat/completions`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ model: 'nothing-declares-this', messages: [{ role: 'user', content: 'ping' }] }),
    });
    assert.equal(response.status, 404, 'no provider declares it, so the provider path answers');
    assert.ok(!calls.some((c) => c.startsWith('sendMessage:')), 'must not reach a backend');
  } finally {
    await gate.close();
  }
});
