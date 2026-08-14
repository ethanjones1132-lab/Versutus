import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderStore } from '../core/providers/store.mjs';

const roots = [];

async function tempHome() {
  const gateHome = await mkdtemp(join(tmpdir(), 'gate-home-'));
  roots.push(gateHome);
  return gateHome;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sample(id = 'openai-main') {
  return {
    config: {
      schemaVersion: 2,
      kind: 'provider',
      id,
      label: 'OpenAI API',
      providerType: 'openai',
      enabled: true,
      registration: {
        mode: 'api_key',
        protocol: 'openai_chat',
        baseUrl: 'https://api.openai.com/v1',
        credentialRef: `provider/${id}/api-key`,
      },
      catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
      requestPolicy: { timeoutMs: 120000 },
    },
    state: {
      catalog: { source: 'live', state: 'fresh', generation: 1, models: [] },
    },
  };
}

test('put is atomic and list never returns a partial record', async () => {
  const store = new ProviderStore(await tempHome());
  const record = sample();
  await store.put(record.config, record.state);
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].config.id, 'openai-main');
  assert.deepEqual(listed[0].state.catalog, record.state.catalog);
});

test('an interrupted temp write is ignored and a later put replaces it', async () => {
  const gateHome = await tempHome();
  const store = new ProviderStore(gateHome);
  await mkdir(join(gateHome, 'config', 'providers'), { recursive: true });
  await writeFile(join(gateHome, 'config', 'providers', 'openai-main.json.tmp'), '{broken', 'utf8');

  assert.deepEqual(await store.list(), []);

  const record = sample();
  await store.put(record.config, record.state);
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].config.id, 'openai-main');
});
