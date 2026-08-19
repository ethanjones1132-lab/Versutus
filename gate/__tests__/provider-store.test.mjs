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

// A legacy v1 provider record carries no `id` field -- the filename is the id.
// One such record (`my-openai.json`) took the whole Gate down on startup:
// ProviderStore returned it with `config.id === undefined`, the manifest mapped
// it to `{ id: undefined }`, and the first `a.id.localeCompare(b.id)` threw
// before the server ever listened.
test('a legacy record with no id field is given the id it was addressed by', async () => {
  const gateHome = await tempHome();
  await mkdir(join(gateHome, 'config', 'providers'), { recursive: true });
  await writeFile(
    join(gateHome, 'config', 'providers', 'my-openai.json'),
    JSON.stringify({
      kind: 'provider',
      label: 'OpenAI',
      config: { flavor: 'openai', baseUrl: 'https://api.openai.com/v1', models: [] },
    }),
    'utf8',
  );

  const store = new ProviderStore(gateHome);

  const record = await store.get('my-openai');
  assert.equal(record.config.id, 'my-openai', 'the filename is the canonical id');

  // list() sorts on config.id, so an id-less record used to throw here too.
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].config.id, 'my-openai');
});

test('an explicit id in the record always wins over the filename', async () => {
  const gateHome = await tempHome();
  await mkdir(join(gateHome, 'config', 'providers'), { recursive: true });
  await writeFile(
    join(gateHome, 'config', 'providers', 'on-disk-name.json'),
    JSON.stringify({ schemaVersion: 2, kind: 'provider', id: 'declared-id', label: 'X' }),
    'utf8',
  );

  const record = await new ProviderStore(gateHome).get('on-disk-name');
  assert.equal(record.config.id, 'declared-id');
});

test('legacy and v2 records sort together without throwing', async () => {
  const gateHome = await tempHome();
  await mkdir(join(gateHome, 'config', 'providers'), { recursive: true });
  await writeFile(
    join(gateHome, 'config', 'providers', 'zz-legacy.json'),
    JSON.stringify({ kind: 'provider', label: 'Legacy', config: {} }),
    'utf8',
  );
  await writeFile(
    join(gateHome, 'config', 'providers', 'aa-modern.json'),
    JSON.stringify({ schemaVersion: 2, kind: 'provider', id: 'aa-modern', label: 'Modern' }),
    'utf8',
  );

  const listed = await new ProviderStore(gateHome).list();
  assert.deepEqual(listed.map((r) => r.config.id), ['aa-modern', 'zz-legacy']);
});
