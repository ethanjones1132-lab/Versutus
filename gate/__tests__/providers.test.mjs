import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadProviders } from '../core/providers.mjs';

async function providerDir(entries) {
  const root = await mkdtemp(join(tmpdir(), 'gate-providers-'));
  for (const [id, source] of Object.entries(entries)) {
    await mkdir(join(root, id), { recursive: true });
    await writeFile(join(root, id, 'provider.mjs'), source, 'utf8');
  }
  return root;
}

const goodProvider = (id) => `
export const id = '${id}';
export const label = '${id}';
export const config = {
  flavor: 'openai',
  baseUrl: 'https://api.example.com/v1',
  apiKeyEnv: 'EXAMPLE_KEY',
  models: ['${id}-1'],
  capabilities: { chat: true, streaming: true },
};
`;

test('loads a valid provider', async () => {
  const root = await providerDir({ grok: goodProvider('grok') });
  const { providers, skipped } = await loadProviders(root);

  assert.equal(providers.length, 1);
  assert.equal(providers[0].id, 'grok');
  assert.deepEqual(skipped, []);
});

test('skips an invalid provider without taking down the others', async () => {
  const root = await providerDir({
    grok: goodProvider('grok'),
    broken: `export const id = 'broken';
export const config = { flavor: 'banana' };`,
  });

  const { providers, skipped } = await loadProviders(root);

  assert.equal(providers.length, 1);
  assert.equal(providers[0].id, 'grok');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /flavor/);
});

test('skips a provider that throws on import', async () => {
  const root = await providerDir({
    grok: goodProvider('grok'),
    exploding: `throw new Error('boom');`,
  });

  const { providers, skipped } = await loadProviders(root);

  assert.equal(providers.length, 1);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /boom/);
});

test('returns empty rather than throwing when there are no providers', async () => {
  const root = await providerDir({});
  const { providers, skipped } = await loadProviders(root);

  assert.deepEqual(providers, []);
  assert.deepEqual(skipped, []);
});
