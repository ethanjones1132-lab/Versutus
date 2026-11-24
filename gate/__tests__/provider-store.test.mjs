import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderStore } from '../core/providers/store.mjs';
import { ProviderService } from '../core/providers/service.mjs';

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

// The body of a record is untrusted input: a hand-edited file, or a copy of
// another provider's record, can claim any `id`. The filename is what `get` was
// addressed by and what `put` writes back to, so believing the body let the copy
// be read under `zen` and then committed over `openai.json`.
test('a copied record is read and written under the filename id it lives in', async () => {
  const gateHome = await tempHome();
  const configDir = join(gateHome, 'config', 'providers');
  await mkdir(configDir, { recursive: true });

  const canonical = sample('openai').config;
  const canonicalBody = JSON.stringify(canonical, null, 2) + '\n';
  await writeFile(join(configDir, 'openai.json'), canonicalBody, 'utf8');
  await writeFile(
    join(configDir, 'zen.json'),
    JSON.stringify({ ...canonical, label: 'Copied' }),
    'utf8',
  );

  const store = new ProviderStore(gateHome);
  const record = await store.get('zen');
  assert.equal(record.config.id, 'zen', 'the filename is the canonical id');
  assert.equal(record.config.label, 'Copied', 'the rest of the stored record is kept');

  // Two files, two ids: the copy must not be reported as the provider it names.
  const listed = await store.list();
  assert.deepEqual(listed.map((entry) => entry.config.id), ['openai', 'zen']);

  // A commit through the service writes back to the file the record was read
  // from, never to the file named by the id in its body.
  const service = new ProviderService({ store });
  await service.noteCredentialSet('zen');
  assert.equal(
    await readFile(join(configDir, 'openai.json'), 'utf8'),
    canonicalBody,
    'the commit rewrote the original provider from the copied record',
  );
  const rewritten = JSON.parse(await readFile(join(configDir, 'zen.json'), 'utf8'));
  assert.equal(rewritten.id, 'zen');
  assert.equal(rewritten.label, 'Copied');
});

test('an explicit id in the record never overrides the filename', async () => {
  const gateHome = await tempHome();
  await mkdir(join(gateHome, 'config', 'providers'), { recursive: true });
  await writeFile(
    join(gateHome, 'config', 'providers', 'on-disk-name.json'),
    JSON.stringify({ schemaVersion: 2, kind: 'provider', id: 'declared-id', label: 'X' }),
    'utf8',
  );

  const record = await new ProviderStore(gateHome).get('on-disk-name');
  assert.equal(record.config.id, 'on-disk-name');
  assert.equal(record.config.label, 'X');
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
