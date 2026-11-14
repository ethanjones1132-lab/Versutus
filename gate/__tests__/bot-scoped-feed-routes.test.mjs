import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGate } from '../core/server.mjs';

test('the live feed routes include named Hermes homes with exact storage scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-scoped-feeds-'));
  const gateHome = join(root, '.gate-home');
  await mkdir(join(root, 'core', 'capabilities', 'provider'), { recursive: true });
  await copyFile(fileURLToPath(new URL('../core/capabilities/provider/kind.mjs', import.meta.url)), join(root, 'core', 'capabilities', 'provider', 'kind.mjs'));
  await mkdir(join(root, 'registry'), { recursive: true });
  await mkdir(join(gateHome, 'config', 'environments'), { recursive: true });
  await writeFile(join(gateHome, 'config', 'environments', 'desktop.json'), JSON.stringify({
    schemaVersion: 1, kind: 'cli-environment', id: 'desktop', label: 'Desktop', adapterId: 'hermes',
    executable: { path: 'C:\\stub.exe' }, protocolPreference: ['acp'],
    versionPolicy: { supported: '1.x', adapterRevision: '1' }, providerRefs: [],
    workspacePolicy: { roots: ['C:\\ws'], defaultRoot: 'C:\\ws', defaultSandbox: 'workspace_write', allowAdditionalRoots: false },
    lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 1 }, enabled: true,
  }));
  const now = Date.now();
  const opened = [];
  const list = (scope) => ({
    listSessions: async () => [{ id: 'equal', title: scope, started_at: now - 1000, last_active: now }],
    listJobs: async () => ({ jobs: [{ id: 'equal', name: scope, schedule: { kind: 'cron', expr: '0 9 * * *', display: 'At 09:00' } }] }),
  });
  const backend = {
    ...list('root'), listBots: async () => [{ id: 'default' }, { id: 'scout' }],
    forBot: async (id) => { opened.push(id); return list(id); },
  };
  const adapter = {
    adapterId: 'hermes', adapterRevision: '1', supportedCliVersions: '1.x', protocolVersions: { acp: '1' },
    capabilities: ['sessions', 'cron'], server: { defaultPort: 1, healthPath: '/', args: () => [], portFromOutput: () => null },
    probe: async () => ({ state: 'ready', cliVersion: '1.0.0', protocol: 'acp' }), createBackend: () => backend,
  };
  let gate;
  try {
    gate = await createGate({ root, gateHome, port: 0,
      environmentRegistry: { get: () => adapter, list: () => [adapter] },
      backendServerFactory: () => ({ ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:1', attached: true }), stop: async () => {}, isOwned: () => false }),
    });
    const base = `http://127.0.0.1:${gate.port}`;
    const headers = { Authorization: `Bearer ${gate.token}` };
    const activity = await (await fetch(`${base}/v1/activity?since=${encodeURIComponent(new Date(now - 60_000).toISOString())}`, { headers })).json();
    assert.equal(activity.items.length, 2);
    assert.equal(activity.items.find((row) => row.title === 'scout').botId, 'scout');
    assert.equal(new Set(activity.items.map((row) => row.id)).size, 2);
    const routines = await (await fetch(`${base}/v1/routines`, { headers })).json();
    assert.deepEqual(routines.routines.map((row) => [row.name, row.scopeBotId, row.schedule]), [
      ['root', null, '0 9 * * *'], ['scout', 'scout', '0 9 * * *'],
    ]);
    assert.deepEqual(opened, ['scout', 'scout']);
  } finally {
    await gate?.close();
    await rm(root, { recursive: true, force: true });
  }
});
