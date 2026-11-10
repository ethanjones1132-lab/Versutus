// ─── A roster read that fails on one environment ──────────────────────────
// The merged roster collected `firstError` and never used it, so an environment
// that could not be read looked exactly like an environment with no Bots: the
// phone showed only the rows that did answer, or an empty list, and nothing said
// the rest of the Gate was broken. These tests pin both halves of the fix —
// a failure beside rows that answered is named on the same list, and a failure
// with nothing to show is reported as an error rather than an empty roster.

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

function auth(gate) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` };
}

/** A CLI adapter whose "native server" is entirely in-process. */
function adapterFor(adapterId, { listBots, startFails, forBot, getBot } = {}) {
  return {
    adapterId,
    adapterRevision: '1',
    supportedCliVersions: '1.x',
    protocolVersions: { acp: '1' },
    capabilities: ['bots'],
    server: { defaultPort: 1, healthPath: '/', args: () => [], portFromOutput: () => null },
    async probe() { return { state: 'ready', cliVersion: '1.0.0', protocol: 'acp' }; },
    createBackend() {
      // A start failure is indistinguishable from an unknown capability before
      // the backend is built, so this adapter is asked and then fails.
      if (startFails) throw startFails;
      const backend = { async listBots() { return listBots(); } };
      // Optional so a test can pin which environment owns a Bot-scoped read:
      // the Gate asks forBot() who owns the id, then the route asks getBot().
      if (forBot) backend.forBot = (botId) => forBot(botId);
      if (getBot) backend.getBot = (botId) => getBot(botId);
      return backend;
    },
  };
}

function registryOf(...adapters) {
  const byId = new Map(adapters.map((adapter) => [adapter.adapterId, adapter]));
  return {
    get(id) {
      const adapter = byId.get(id);
      if (!adapter) throw new Error(`unknown CLI adapter "${id}"`);
      return adapter;
    },
    list() { return [...byId.values()]; },
  };
}

async function makeGate({ registry, environments }) {
  const root = await mkdtemp(join(tmpdir(), 'gate-roster-'));
  roots.push(root);
  const gateHome = join(root, '.gate-home');
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });
  for (const env of environments) {
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
  return createGate({
    root,
    port: 0,
    gateHome,
    environmentRegistry: registry,
    backendServerFactory: () => ({
      ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:1', attached: true }),
      stop: async () => {},
      isOwned: () => false,
    }),
  });
}

const HEALTHY_ROWS = [{ id: 'researcher', displayName: 'researcher', routable: true }];

function brokenRoster() {
  return Object.assign(new Error('opencode answered /v1/bots with text/html, not JSON'), {
    code: 'backend_not_json',
    status: 502,
  });
}

test('a failed environment is named beside the rows that did answer', async () => {
  const gate = await makeGate({
    registry: registryOf(
      adapterFor('brokencli', { listBots: () => { throw brokenRoster(); } }),
      adapterFor('healthycli', { listBots: () => ({ object: 'list', data: HEALTHY_ROWS }) }),
    ),
    environments: [
      { id: 'a-broken', adapterId: 'brokencli' },
      { id: 'b-healthy', adapterId: 'healthycli' },
    ],
  });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/bots`, { headers: auth(gate) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data, [{
      id: 'researcher',
      displayName: 'researcher',
      routable: true,
      backendId: 'b-healthy',
      runtime: 'healthycli',
    }]);
    assert.deepEqual(body.warnings, [{
      backendId: 'a-broken',
      code: 'backend_not_json',
      message: 'opencode answered /v1/bots with text/html, not JSON',
    }]);
  } finally {
    await gate.close();
  }
});

test('an empty roster from one environment still reports the other failure', async () => {
  // The exact confusion this fixes: "no Bots on b" and "a could not be read"
  // both arrived as an empty list, so the phone claimed there were no Bots.
  const gate = await makeGate({
    registry: registryOf(
      adapterFor('brokencli', { listBots: () => { throw brokenRoster(); } }),
      adapterFor('emptycli', { listBots: () => ({ object: 'list', data: [] }) }),
    ),
    environments: [
      { id: 'a-broken', adapterId: 'brokencli' },
      { id: 'b-empty', adapterId: 'emptycli' },
    ],
  });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/bots`, { headers: auth(gate) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data, []);
    assert.equal(body.warnings.length, 1);
    assert.equal(body.warnings[0].backendId, 'a-broken');
    assert.equal(body.warnings[0].code, 'backend_not_json');
  } finally {
    await gate.close();
  }
});

test('a merge with nothing broken adds no warnings key', async () => {
  const gate = await makeGate({
    registry: registryOf(
      adapterFor('hermescli', { listBots: () => ({ object: 'list', data: [{ id: 'researcher', routable: true }] }) }),
      adapterFor('opencodecli', { listBots: () => ({ object: 'list', data: [{ id: 'scout', routable: true }] }) }),
    ),
    environments: [
      { id: 'a-hermes', adapterId: 'hermescli' },
      { id: 'b-opencode', adapterId: 'opencodecli' },
    ],
  });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/bots`, { headers: auth(gate) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data.map((bot) => [bot.id, bot.backendId]), [
      ['researcher', 'a-hermes'],
      ['scout', 'b-opencode'],
    ]);
    assert.equal('warnings' in body, false, 'a healthy roster says nothing about warnings');
  } finally {
    await gate.close();
  }
});

test('when nothing answered, the first failure is reported instead of an empty roster', async () => {
  const startFailure = Object.assign(new Error('environment a-broken could not start'), {
    code: 'environment_start_failed',
    status: 502,
  });
  const readFailure = Object.assign(new Error('environment b-broken answered with HTML'), {
    code: 'backend_not_json',
    status: 502,
  });
  const gate = await makeGate({
    registry: registryOf(
      adapterFor('startfailcli', { startFails: startFailure }),
      adapterFor('brokencli', { listBots: () => { throw readFailure; } }),
    ),
    environments: [
      { id: 'a-broken', adapterId: 'startfailcli' },
      { id: 'b-broken', adapterId: 'brokencli' },
    ],
  });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/bots`, { headers: auth(gate) });
    assert.equal(response.status, 502);
    // The first failure, not whichever environment the fallback path happened
    // to try next: the roster was never read, and the answer says so.
    assert.deepEqual(await response.json(), {
      error: {
        message: 'environment a-broken could not start',
        code: 'environment_start_failed',
      },
    });
  } finally {
    await gate.close();
  }
});

// ─── Two environments using one Bot id ────────────────────────────────────
// A Hermes profile and the built-in Codex Bot can share an id. First-wins kept
// the first and silently dropped the second, so one Bot vanished with no trace.
// These tests pin that the clash is named (in the list and in the log), that
// ownership resolves to the row that was kept, and that group membership checks
// see Bots on every environment rather than only the first.

/** Two environments that both answer to a Bot called `researcher`. */
function clashingRoster() {
  const rows = [{ id: 'researcher', displayName: 'researcher', routable: true }];
  return {
    registry: registryOf(
      adapterFor('hermescli', {
        listBots: () => ({ object: 'list', data: rows }),
        forBot: async () => ({ id: 'researcher' }),
        getBot: async () => ({ id: 'researcher', soul: 'from-a-hermes' }),
      }),
      adapterFor('codexcli', {
        listBots: () => ({ object: 'list', data: rows }),
        forBot: async () => ({ id: 'researcher' }),
        getBot: async () => ({ id: 'researcher', soul: 'from-b-codex' }),
      }),
    ),
    environments: [
      { id: 'a-hermes', adapterId: 'hermescli' },
      { id: 'b-codex', adapterId: 'codexcli' },
    ],
  };
}

test('a Bot id two environments both use is named instead of silently hidden', async () => {
  const gate = await makeGate(clashingRoster());
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/bots`, { headers: auth(gate) });
    assert.equal(response.status, 200);
    const body = await response.json();
    // First-wins is unchanged: the first environment's row is the one shown.
    assert.deepEqual(body.data, [{
      id: 'researcher',
      displayName: 'researcher',
      routable: true,
      backendId: 'a-hermes',
      runtime: 'hermescli',
    }]);
    // The dropped row is not gone without a trace.
    assert.equal(body.warnings.length, 1);
    assert.equal(body.warnings[0].backendId, 'b-codex');
    assert.equal(body.warnings[0].code, 'bot_id_conflict');
    const message = body.warnings[0].message;
    assert.match(message, /researcher/);
    assert.match(message, /a-hermes/);
    assert.match(message, /b-codex/);
  } finally {
    await gate.close();
  }
});

test('the Gate log names a clash once, while the API warns every time', async () => {
  // The phone refetches the roster on every visit; a persistent clash would
  // otherwise write the same line for the life of the Gate. The log is for
  // grepping after the fact, so it says it once; the payload never goes quiet.
  const gate = await makeGate(clashingRoster());
  const warned = [];
  const original = console.warn;
  console.warn = (...args) => { warned.push(args.join(' ')); };
  try {
    for (let i = 0; i < 2; i += 1) {
      const response = await fetch(`http://127.0.0.1:${gate.port}/v1/bots`, { headers: auth(gate) });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).warnings[0].code, 'bot_id_conflict');
      const clashLines = warned.filter((line) => line.includes('researcher') && line.includes('b-codex'));
      assert.equal(clashLines.length, Math.min(i + 1, 1), `after fetch ${i + 1}`);
    }
  } finally {
    console.warn = original;
    await gate.close();
  }
});

test('a group write names the real reason the roster could not be read', async () => {
  // Every environment failing to build is not "no backend lists bots": the
  // operator needs the cause, not a generic refusal, or the 502 is untraceable.
  const startFailure = Object.assign(new Error('environment a-broken could not start'), {
    code: 'environment_start_failed',
    status: 502,
  });
  const gate = await makeGate({
    registry: registryOf(adapterFor('startfailcli', { startFails: startFailure })),
    environments: [{ id: 'a-broken', adapterId: 'startfailcli' }],
  });
  try {
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/bot-groups`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ name: 'crew', memberIds: ['researcher', 'scout'] }),
    });
    const body = await response.json();
    assert.equal(response.status, 502, JSON.stringify(body));
    assert.equal(body.error.code, 'roster_unavailable');
    assert.match(body.error.message, /could not start/);
  } finally {
    await gate.close();
  }
});

test('ownership resolves to the environment whose row was kept', async () => {
  const gate = await makeGate(clashingRoster());
  try {
    // The roster keeps a-hermes, so a Bot-scoped read must be served by
    // a-hermes too. If these disagreed, a Bot would list but answer from (or
    // 404 on) the environment the roster never showed.
    const response = await fetch(`http://127.0.0.1:${gate.port}/v1/bots/researcher`, {
      headers: auth(gate),
    });
    assert.equal(response.status, 200);
    const bot = await response.json();
    assert.equal(bot.soul, 'from-a-hermes');
  } finally {
    await gate.close();
  }
});

test('group membership sees Bots on every environment, not just the first', async () => {
  const gate = await makeGate({
    registry: registryOf(
      adapterFor('hermescli', { listBots: () => ({ object: 'list', data: [{ id: 'researcher', routable: true }] }) }),
      adapterFor('codexcli', { listBots: () => ({ object: 'list', data: [{ id: 'scout', routable: true }] }) }),
      adapterFor('brokencli', { listBots: () => { throw brokenRoster(); } }),
    ),
    environments: [
      { id: 'a-hermes', adapterId: 'hermescli' },
      { id: 'b-codex', adapterId: 'codexcli' },
      { id: 'c-broken', adapterId: 'brokencli' },
    ],
  });
  const base = `http://127.0.0.1:${gate.port}`;
  try {
    // `scout` lives on the SECOND environment, so only the union of every
    // roster can confirm it; the third environment failing must not sink that.
    const created = await fetch(`${base}/v1/bot-groups`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ name: 'crew', memberIds: ['researcher', 'scout'] }),
    });
    assert.equal(created.status, 200);
    assert.deepEqual((await created.json()).memberIds, ['researcher', 'scout']);

    // A genuinely unknown id still dies at the door with 400.
    const refused = await fetch(`${base}/v1/bot-groups`, {
      method: 'POST',
      headers: auth(gate),
      body: JSON.stringify({ name: 'ghosts', memberIds: ['researcher', 'nobody'] }),
    });
    assert.equal(refused.status, 400);
    const body = await refused.json();
    assert.equal(body.error.code, 'unknown_member');
    assert.match(body.error.message, /nobody/);
  } finally {
    await gate.close();
  }
});
