import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';
import { createClaudeCodeBackend } from '../core/cli-environments/backends/claude-code.mjs';
import { createCodexBackend } from '../core/cli-environments/backends/codex.mjs';
import { claudeCodeAdapter } from '../core/cli-environments/adapters/claude-code.mjs';
import { codexAdapter } from '../core/cli-environments/adapters/codex.mjs';

// ADR 0016 made a Bot an OpenCode agent as well as a Hermes profile. Claude
// Code lists its own agent files as Bots too, but the Gate only reads them —
// it never writes an agent, so create and edit stay unimplemented for Claude
// Code and Codex alike and are refused by name rather than inventing an
// editable roster. Codex profiles are still a later slice.

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const CLAUDE_ROW = {
  id: 'claude-code',
  displayName: 'Claude Code',
  routable: true,
  routingIssue: null,
  description: "Anthropic's coding agent on this computer",
  model: null,
  runtime: 'claude-code',
};

const CODEX_ROW = {
  id: 'codex',
  displayName: 'Codex',
  routable: true,
  routingIssue: null,
  description: "OpenAI's coding agent on this computer",
  model: null,
  runtime: 'codex',
};

async function claudeBackend() {
  const root = await mkdtemp(join(tmpdir(), 'gate-claude-bots-'));
  roots.push(root);
  return createClaudeCodeBackend({
    executablePath: 'C:\\stub.exe',
    cwd: 'C:\\ws',
    claudeHome: root,
  });
}

/** A Codex app-server stub: only the calls a Bot read makes are answered. */
function fakeCodexRpc(threads = []) {
  const calls = [];
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/list') return { data: threads };
      return {};
    },
  };
}

test('Claude Code lists its built-in Bot alone when no agent files exist', async () => {
  const backend = await claudeBackend();
  // The temp home and `C:\ws` hold no `agents` directory, so the roster is the
  // agent itself — the same fixed row, ahead of any agent file that appears.
  assert.deepEqual(await backend.listBots(), { object: 'list', data: [CLAUDE_ROW] });
});

test('Codex lists exactly one Bot: the agent itself', async () => {
  const backend = createCodexBackend({ rpc: fakeCodexRpc(), cwd: 'C:\\ws' });
  assert.deepEqual(await backend.listBots(), { object: 'list', data: [CODEX_ROW] });
});

test('each fixed Bot reads back, and only under its own id', async () => {
  const claude = await claudeBackend();
  // `soul` is present-but-null: the Gate has no standing-instructions file for
  // a built-in agent, and an absent field would read as a failed soul read.
  assert.deepEqual(await claude.getBot({ id: 'claude-code' }), { ...CLAUDE_ROW, soul: null });
  const codex = createCodexBackend({ rpc: fakeCodexRpc(), cwd: 'C:\\ws' });
  assert.deepEqual(await codex.getBot({ id: 'codex' }), { ...CODEX_ROW, soul: null });
});

test('an unknown id is unknown_bot, so the Gate can ask the other runtime', async () => {
  const claude = await claudeBackend();
  const codex = createCodexBackend({ rpc: fakeCodexRpc(), cwd: 'C:\\ws' });
  // Each runtime must disown the other's Bot: findBotOwner moves on only on
  // unknown_bot, and a wrong claim would hide the Bot behind an unhealthy owner.
  for (const id of ['nobody', 'codex']) {
    await assert.rejects(claude.getBot({ id }), { code: 'unknown_bot', status: 404 });
    await assert.rejects(claude.forBot(id), { code: 'unknown_bot', status: 404 });
  }
  for (const id of ['nobody', 'claude-code']) {
    await assert.rejects(codex.getBot({ id }), { code: 'unknown_bot', status: 404 });
    await assert.rejects(codex.forBot(id), { code: 'unknown_bot', status: 404 });
  }
});

test('Claude Code forBot labels its one Bot and hides none of its sessions', async () => {
  const backend = await claudeBackend();
  const created = await backend.createSession({ title: 'Bot Chat' });
  const scoped = await backend.forBot('claude-code');
  assert.equal(scoped.bot, 'claude-code');
  assert.equal(scoped.kind, 'claude-code');
  // Every session on the environment already belongs to its one Bot, so the
  // scoped view is the same list, not a filtered one.
  assert.deepEqual((await scoped.listSessions()).map((session) => session.id), [created.id]);
});

test('Codex forBot labels its one Bot and hides none of its threads', async () => {
  const rpc = fakeCodexRpc([{ id: 'th_1', name: 'Bot Chat', cwd: 'C:\\ws', updatedAt: 1 }]);
  const backend = createCodexBackend({ rpc, cwd: 'C:\\ws' });
  const scoped = await backend.forBot('codex');
  assert.equal(scoped.bot, 'codex');
  assert.equal(scoped.kind, 'codex');
  assert.deepEqual((await scoped.listSessions()).map((session) => session.id), ['th_1']);
  assert.equal(rpc.calls.filter((call) => call.method === 'thread/list').length, 1);
});

test('both adapters advertise bots and expose the methods backendCanServe probes', () => {
  const record = { executable: { path: 'C:\\stub.exe' }, workspacePolicy: { defaultRoot: 'C:\\ws' } };
  for (const [adapter, id] of [[claudeCodeAdapter, 'claude-code'], [codexAdapter, 'codex']]) {
    assert.ok(adapter.capabilities.includes('bots'), `${id} must advertise the bots capability`);
    const probed = adapter.createBackend({ record });
    for (const method of ['listBots', 'getBot', 'forBot']) {
      assert.equal(typeof probed[method], 'function', `${id} must expose ${method}`);
    }
    // Read-only Bots: Claude Code owns its agent files, and Codex has no
    // profiles here, so nothing is created or edited through the Gate.
    assert.equal(probed.createBot, undefined, `${id} must not offer createBot`);
    assert.equal(probed.updateBot, undefined, `${id} must not offer updateBot`);
  }
});

// ─── The Gate's merged roster ────────────────────────────────────────────

/** A Hermes-shaped environment: the one runtime that already owned Bots. */
function hermesAdapter() {
  const hermesBot = { id: 'default', displayName: 'default', routable: true, routingIssue: null, description: null, model: null };
  return {
    adapterId: 'hermes',
    adapterRevision: '1',
    supportedCliVersions: '0.18.x-0.21.x',
    protocolVersions: { acp: '1' },
    server: { defaultPort: 1, healthPath: '/health', args: () => [], portFromOutput: () => null },
    capabilities: ['chat', 'sessions', 'models', 'bots'],
    async probe() { return { state: 'ready', cliVersion: '0.19.32', protocol: 'acp' }; },
    createBackend() {
      return {
        kind: 'hermes',
        async listSessions() { return []; },
        async createSession() { return {}; },
        async deleteSession() {},
        async listMessages() { return []; },
        async sendMessage() { return { text: '' }; },
        async listModels() { return []; },
        async abort() {},
        async replyApproval() {},
        async streamEvents() {},
        async listBots() { return { object: 'list', data: [hermesBot] }; },
        async getBot({ id }) {
          if (id !== hermesBot.id) {
            throw Object.assign(new Error(`unknown bot "${id}"`), { code: 'unknown_bot', status: 404 });
          }
          return { ...hermesBot, soul: '' };
        },
        async forBot(botId) {
          if (botId !== hermesBot.id) {
            throw Object.assign(new Error(`unknown bot "${botId}"`), { code: 'unknown_bot', status: 404 });
          }
          return { ...this, bot: botId };
        },
      };
    },
  };
}

function cliBotsRegistry() {
  const adapters = [hermesAdapter(), claudeCodeAdapter, codexAdapter];
  return {
    get(id) {
      const found = adapters.find((adapter) => adapter.adapterId === id);
      if (!found) throw new Error(`unknown CLI adapter "${id}"`);
      return found;
    },
    list() { return adapters; },
  };
}

const ENVIRONMENTS = [
  { id: 'a-hermes', adapterId: 'hermes', supported: '0.18.x-0.21.x' },
  { id: 'b-claude-code', adapterId: 'claude-code', supported: '2.1.x' },
  { id: 'c-codex', adapterId: 'codex', supported: '0.142.x-0.147.x' },
];

async function makeGate() {
  const root = await mkdtemp(join(tmpdir(), 'gate-cli-bots-'));
  roots.push(root);
  const gateHome = join(root, '.gate-home');
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });
  for (const env of ENVIRONMENTS) {
    await writeFile(join(gateHome, 'config', 'environments', `${env.id}.json`), JSON.stringify({
      schemaVersion: 1,
      kind: 'cli-environment',
      id: env.id,
      label: env.id,
      adapterId: env.adapterId,
      executable: { path: 'C:\\stub.exe' },
      protocolPreference: ['acp'],
      versionPolicy: { supported: env.supported, adapterRevision: '1' },
      providerRefs: [],
      workspacePolicy: { roots: ['C:\\ws'], defaultRoot: 'C:\\ws', defaultSandbox: 'workspace_write', allowAdditionalRoots: false },
      lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 1 },
      enabled: true,
    }), 'utf8');
  }
  return createGate({
    root,
    port: 0,
    gateHome,
    environmentRegistry: cliBotsRegistry(),
    // No process is needed: every environment reports itself reachable, which
    // is what lets the roster read reach the new `listBots` implementations.
    backendServerFactory: () => ({
      ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:1', attached: true }),
      stop: async () => {},
      isOwned: () => false,
    }),
  });
}

const auth = (gate) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` });
const base = (gate) => `http://127.0.0.1:${gate.port}`;

test('GET /v1/bots merges Hermes, Claude Code and Codex, tagging every row', async () => {
  const gate = await makeGate();
  try {
    const response = await fetch(`${base(gate)}/v1/bots`, { headers: auth(gate) });
    assert.equal(response.status, 200);
    const roster = await response.json();
    assert.deepEqual(
      roster.data.map((bot) => [bot.id, bot.displayName, bot.backendId, bot.runtime]),
      [
        ['default', 'default', 'a-hermes', 'hermes'],
        ['claude-code', 'Claude Code', 'b-claude-code', 'claude-code'],
        ['codex', 'Codex', 'c-codex', 'codex'],
      ],
    );
    assert.equal(roster.data[1].routable, true);
    assert.equal(roster.data[2].description, "OpenAI's coding agent on this computer");
    assert.deepEqual(roster.warnings, undefined, 'a healthy roster names no failures');
  } finally {
    await gate.close();
  }
});

test('a fixed Bot is read through the environment that owns it', async () => {
  const gate = await makeGate();
  try {
    const codex = await fetch(`${base(gate)}/v1/bots/codex`, { headers: auth(gate) });
    assert.equal(codex.status, 200);
    const row = await codex.json();
    assert.equal(row.displayName, 'Codex');
    assert.equal(row.runtime, 'codex');

    // Nobody owns it: Hermes answers unknown_bot, Claude Code disowns it too,
    // and the Gate reports that honestly instead of reading the first runtime.
    const missing = await fetch(`${base(gate)}/v1/bots/nobody`, { headers: auth(gate) });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'unknown_bot');
  } finally {
    await gate.close();
  }
});
