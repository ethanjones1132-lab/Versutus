import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';

const kindModulePath = fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url));
const roots = [];
const since = '2026-11-09T00:00:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function session(id, lastActive, extras = {}) {
  return {
    id,
    started_at: lastActive - 60_000,
    last_active: lastActive,
    title: id,
    ended_at: null,
    ...extras,
  };
}

async function makeGate({ sessions = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gate-activity-'));
  roots.push(root);
  const gateHome = join(root, '.gate-home');
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(kindModulePath, join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });

  for (const id of ['backend-a', 'backend-b', 'backend-failing']) {
    await writeFile(join(gateHome, 'config', 'environments', `${id}.json`), JSON.stringify({
      schemaVersion: 1, kind: 'cli-environment', id, label: id.toUpperCase(),
      adapterId: id, executable: { path: 'C:\\stub.exe' }, protocolPreference: ['acp'],
      versionPolicy: { supported: '1.x', adapterRevision: '1' }, providerRefs: [],
      workspacePolicy: { roots: ['C:\\ws'], defaultRoot: 'C:\\ws', defaultSandbox: 'workspace_write', allowAdditionalRoots: false },
      lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 1 },
      enabled: true,
    }), 'utf8');
  }

  const registry = {
    get(id) {
      return {
        adapterId: id,
        adapterRevision: '1',
        supportedCliVersions: '1.x',
        protocolVersions: { acp: '1' },
        capabilities: ['sessions'],
        server: { defaultPort: 1, healthPath: '/', args: () => [], portFromOutput: () => null },
        async probe() { return { state: 'ready', cliVersion: '1.0.0', protocol: 'acp' }; },
        createBackend: () => ({
          async listSessions() {
            if (id === 'backend-failing') throw new Error('fake backend is offline');
            return sessions[id] ?? [];
          },
        }),
      };
    },
    list() { return ['backend-a', 'backend-b', 'backend-failing'].map((id) => this.get(id)); },
  };
  const gate = await createGate({
    root, gateHome, port: 0, environmentRegistry: registry,
    backendServerFactory: () => ({
      ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:1', attached: true }),
      stop: async () => {},
      isOwned: () => false,
    }),
  });
  return gate;
}

const auth = (gate) => ({ Authorization: `Bearer ${gate.token}` });
const url = (gate, query = `since=${encodeURIComponent(since)}`) => `http://127.0.0.1:${gate.port}/v1/activity?${query}`;

test('GET /v1/activity merges backends newest first and filters by since', async () => {
  const gate = await makeGate({ sessions: {
    'backend-a': [
      session('old', Date.parse('2026-11-08T23:59:00Z')),
      session('newer', Date.parse('2026-11-09T12:00:00Z'), { message_count: 4, tool_call_count: 2 }),
    ],
    'backend-b': [session('newest', Date.parse('2026-11-09T18:00:00Z'))],
  } });
  try {
    const response = await fetch(url(gate), { headers: auth(gate) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.items.map((item) => item.sessionId), ['newest', 'newer']);
    assert.equal(body.items[1].metrics.turns, 4);
    assert.equal(body.items[1].metrics.tools, 2);
    assert.equal(body.backends.find((backend) => backend.id === 'backend-a').status, 'complete');
  } finally {
    await gate.close();
  }
});

test('a failed backend is reported without hiding healthy backend items', async () => {
  const gate = await makeGate({ sessions: {
    'backend-a': [session('healthy', Date.parse('2026-11-09T12:00:00Z'))],
  } });
  try {
    const response = await fetch(url(gate), { headers: auth(gate) });
    const body = await response.json();
    // Its session read failed but its run archive answered: partial, with the error named.
    assert.equal(body.backends.find((backend) => backend.id === 'backend-failing').status, 'partial');
    assert.match(body.backends.find((backend) => backend.id === 'backend-failing').error, /offline/);
    assert.deepEqual(body.items.map((item) => item.sessionId), ['healthy']);
  } finally {
    await gate.close();
  }
});

test('unknown session metrics are omitted and backendId narrows coverage and items', async () => {
  const gate = await makeGate({ sessions: {
    'backend-a': [session('without-metrics', Date.parse('2026-11-09T12:00:00Z'))],
    'backend-b': [session('other', Date.parse('2026-11-09T13:00:00Z'))],
  } });
  try {
    const response = await fetch(url(gate, `since=${encodeURIComponent(since)}&backendId=backend-a`), { headers: auth(gate) });
    const body = await response.json();
    assert.deepEqual(body.backends.map((backend) => backend.id), ['backend-a']);
    assert.deepEqual(body.items.map((item) => item.sessionId), ['without-metrics']);
    assert.deepEqual(body.items[0].metrics, {});
    assert.equal(Object.hasOwn(body.items[0], 'botId'), false);
  } finally {
    await gate.close();
  }
});

test('a session from a Bot-capable backend keeps its Bot on the wire', async () => {
  const gate = await makeGate({ sessions: {
    'backend-a': [session('opencode-thread', Date.parse('2026-11-09T12:00:00Z'), { bot: 'build' })],
  } });
  try {
    const response = await fetch(url(gate, `since=${encodeURIComponent(since)}&backendId=backend-a`), { headers: auth(gate) });
    const body = await response.json();
    assert.equal(body.items[0].sessionId, 'opencode-thread');
    assert.equal(body.items[0].botId, 'build');
  } finally {
    await gate.close();
  }
});

test('missing or unparseable since is rejected with a clear 400 response', async () => {
  const gate = await makeGate();
  try {
    for (const query of ['', 'since=not-a-date']) {
      const response = await fetch(url(gate, query), { headers: auth(gate) });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error.message, /since/);
    }
  } finally {
    await gate.close();
  }
});

test('GET /v1/activity requires Gate authentication', async () => {
  const gate = await makeGate();
  try {
    const response = await fetch(url(gate));
    assert.equal(response.status, 401);
  } finally {
    await gate.close();
  }
});
