import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEnvironmentRpc } from '../core/cli-environments/rpc.mjs';
import { CliEnvironmentStore } from '../core/cli-environments/store.mjs';
import { validateCliEnvironmentRegistration } from '../core/cli-environments/schema.mjs';
import { ProviderStore } from '../core/providers/store.mjs';
import { validateProviderRegistration } from '../core/providers/schema.mjs';
import { validEnvironment } from './fixtures/cli-environment.mjs';

// Ids that would name a file outside the record directory if they reached a
// path join. The first four are the cases the store boundary has to refuse.
const PATH_IDS = ['../x', '..\\x', 'a/b', '', '../../device-tokens'];

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function gateHome() {
  const home = await mkdtemp(join(tmpdir(), 'gate-record-id-'));
  roots.push(home);
  // A file one level above the provider and environment directories. A path
  // id that escapes the directory would reach it, so it is the thing to protect.
  await mkdir(join(home, 'config'), { recursive: true });
  await writeFile(join(home, 'device-tokens.json'), '{"devices":[]}\n');
  return home;
}

function provider(id = 'openai-main') {
  return {
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
  };
}

test('both schemas reject a path-shaped id and name the id field', () => {
  for (const id of PATH_IDS) {
    const env = validateCliEnvironmentRegistration(validEnvironment({ id }));
    assert.equal(env.ok, false, `environment id ${JSON.stringify(id)} must be refused`);
    assert.ok(env.errors.some((error) => error.field === 'id'), `environment error must name id for ${JSON.stringify(id)}`);

    const providerResult = validateProviderRegistration(provider(id));
    assert.equal(providerResult.ok, false, `provider id ${JSON.stringify(id)} must be refused`);
    assert.ok(providerResult.errors.some((error) => error.field === 'id'), `provider error must name id for ${JSON.stringify(id)}`);
  }
});

test('both schemas keep accepting the ids already in use', () => {
  for (const id of ['openai-main', 'codex-local', 'Hermes.Local_2']) {
    assert.equal(validateCliEnvironmentRegistration(validEnvironment({ id })).ok, true, id);
    assert.equal(validateProviderRegistration(provider(id)).ok, true, id);
  }
});

test('the environment store refuses a path id on read, write and delete', async () => {
  const home = await gateHome();
  const store = new CliEnvironmentStore(home);
  const outside = join(home, 'config', 'outside.json');
  await writeFile(outside, JSON.stringify(validEnvironment({ id: 'outside' })));

  assert.equal(await store.get('../outside'), null, 'get must not read outside the directory');
  assert.equal(await store.get('..\\outside'), null);
  assert.equal(await store.get(''), null);

  await assert.rejects(store.put(validEnvironment({ id: '../outside' })), /id/);
  assert.equal(await readFile(outside, 'utf8'), JSON.stringify(validEnvironment({ id: 'outside' })));

  await assert.rejects(store.delete('../../device-tokens'), /invalid record id/);
  await access(join(home, 'device-tokens.json'));
  await access(outside);
});

test('the provider store refuses a path id on read, write and delete', async () => {
  const home = await gateHome();
  const store = new ProviderStore(home);
  const outside = join(home, 'config', 'outside.json');
  await writeFile(outside, JSON.stringify(provider('outside')));

  assert.equal(await store.get('../outside'), null, 'get must not read outside the directory');
  assert.equal(await store.get('a/b'), null);

  await assert.rejects(store.put(provider('../outside'), {}), /id/);
  await assert.rejects(access(join(home, 'state', 'outside.json')));
  assert.equal(await readFile(outside, 'utf8'), JSON.stringify(provider('outside')));

  await assert.rejects(store.delete('../../device-tokens'), /invalid record id/);
  await access(join(home, 'device-tokens.json'));
});

test('the environment RPC refuses a path id before it reaches the disk', async () => {
  const home = await gateHome();
  const rpc = createEnvironmentRpc({
    store: new CliEnvironmentStore(home),
    service: { environmentState: new Map() },
    registry: { get: () => undefined, list: () => [] },
  });

  await assert.rejects(rpc['environments.delete']({ id: '../../device-tokens' }));
  await access(join(home, 'device-tokens.json'));
  await assert.rejects(rpc['environments.create'](validEnvironment({ id: '../x' })), /id/);
  await assert.rejects(access(join(home, 'config', 'x.json')));
});

test('ids already in use still read, write and delete', async () => {
  const home = await gateHome();
  const environments = new CliEnvironmentStore(home);
  const providers = new ProviderStore(home);

  await environments.put(validEnvironment({ id: 'openai-main' }));
  assert.equal((await environments.get('openai-main'))?.id, 'openai-main');
  await environments.delete('openai-main');
  assert.equal(await environments.get('openai-main'), null);

  await providers.put(provider('Codex.local'), {});
  assert.equal((await providers.get('Codex.local'))?.config.id, 'Codex.local');
  await providers.delete('Codex.local');
  assert.equal(await providers.get('Codex.local'), null);
});
