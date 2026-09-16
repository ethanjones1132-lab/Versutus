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
      calls.push(`sendMessage:${botId}:${input?.model?.providerId ?? ''}/${input?.model?.modelId ?? ''}`);
      return { text: 'ok', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, runtime: { model: input?.model?.modelId } };
    },
    async listModels() {
      calls.push(`listModels:${botId}`);
      return [{ id: 'opencode-go-session/deepseek-v4-flash', providerId: 'opencode-go-session', modelId: 'deepseek-v4-flash', label: 'OpenCode Go · deepseek-v4-flash', available: true }];
    },
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
  const root = await mkdtemp(join(tmpdir(), 'gate-hermesscope-'));
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


// 2026-09-16: every chat is meant to go through Hermes. A Bot's model picker
// was fed the Gate's OWN provider catalogue because /v1/models ignored `bot=`,
// so the operator pinned "opencode-go/omen-alpha" — a provider Hermes does not
// have — onto a Bot, and every turn after that failed. An unscoped chat with no
// model fell to the Gate's first advertised provider model and failed with that
// provider's 404.

test("a Bot's model list is that Bot's Hermes catalogue, never the Gate's providers", async () => {
  const { gate, calls } = await makeGate();
  try {
    const response = await fetch(`${base(gate)}/v1/models?bot=default`, { headers: auth(gate) });
    assert.equal(response.status, 200);
    const body = await response.json();
    const ids = body.data.map((model) => model.id);
    assert.deepEqual(ids, ['opencode-go-session/deepseek-v4-flash']);
    assert.ok(calls.includes('listModels:default'));
  } finally {
    await gate.close();
  }
});

test('an unknown Bot is refused by name, not answered with provider models', async () => {
  const { gate } = await makeGate();
  try {
    const response = await fetch(`${base(gate)}/v1/models?bot=ghost`, { headers: auth(gate) });
    assert.notEqual(response.status, 200);
  } finally {
    await gate.close();
  }
});

test('a Bot turn pinned to a Hermes model reaches Hermes with the provider split out', async () => {
  const { gate, calls } = await makeGate();
  try {
    const response = await fetch(`${base(gate)}/v1/chat/completions`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ bot: 'default', model: 'opencode-go-session/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200);
    assert.ok(calls.includes('sendMessage:default:opencode-go-session/deepseek-v4-flash'));
  } finally {
    await gate.close();
  }
});

test('a chat that names no Bot, backend or model is refused clearly instead of guessing a provider', async () => {
  const { gate } = await makeGate();
  try {
    const response = await fetch(`${base(gate)}/v1/chat/completions`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'scope_required');
    assert.match(body.error.message, /Bot|backend|model/);
  } finally {
    await gate.close();
  }
});
