import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildManifest } from '../core/manifest.mjs';

/** A ProviderService snapshot, shaped as toSnapshot() returns it. */
function snapshot(id, overrides = {}) {
  return {
    id,
    label: id.toUpperCase(),
    providerType: 'openai-compatible',
    mode: 'api_key',
    auth: { state: 'ready', credentialCustodian: 'gate' },
    readiness: { state: 'ready', checkedAt: '2026-08-15T00:00:00Z' },
    catalog: {
      state: 'fresh',
      source: 'live',
      generation: 1,
      models: [{ providerId: id, id: `${id}/model-a`, available: true }],
    },
    ...overrides,
  };
}

/** A legacy registry instance, as resolveManifestInstances() produces it. */
function legacyInstance(id) {
  return {
    kind: 'provider',
    manifestEntry: {
      id,
      label: `legacy ${id}`,
      basePath: `/p/${id}`,
      models: ['legacy-model'],
      capabilities: { chat: true, streaming: true },
    },
  };
}

test('a v2 provider reaches the manifest with its live state', () => {
  const manifest = buildManifest({ name: 'Gate', providerSnapshots: [snapshot('nvidia')] });
  const entry = manifest.providers.find((provider) => provider.id === 'nvidia');
  assert.ok(entry, 'the v2 provider must appear in the manifest');
  assert.equal(entry.readiness.state, 'ready');
  assert.equal(entry.auth.state, 'ready');
  assert.equal(entry.catalog.state, 'fresh');
  assert.equal(entry.catalog.source, 'live');
  assert.equal(entry.catalog.count, 1);
  assert.deepEqual(entry.models, ['nvidia/model-a']);
  assert.equal(entry.basePath, '/p/nvidia');
});

test('a v2 record wins over a legacy record with the same id', () => {
  const manifest = buildManifest({
    name: 'Gate',
    providerSnapshots: [snapshot('nvidia')],
    capabilityInstances: [legacyInstance('nvidia')],
  });
  const matches = manifest.providers.filter((provider) => provider.id === 'nvidia');
  assert.equal(matches.length, 1, 'a duplicate id must not appear twice');
  assert.equal(matches[0].label, 'NVIDIA', 'the v2 record must win');
});

test('a legacy provider with no v2 counterpart is retained', () => {
  const manifest = buildManifest({
    name: 'Gate',
    providerSnapshots: [snapshot('opencode-zen')],
    capabilityInstances: [legacyInstance('someone-else')],
  });
  assert.deepEqual(
    manifest.providers.map((provider) => provider.id),
    ['opencode-zen', 'someone-else'],
    'v2 first, then legacy, each sorted by id',
  );
});

test('provider entries carry state, never credentials', () => {
  const manifest = buildManifest({
    name: 'Gate',
    providerSnapshots: [
      snapshot('nvidia', { config: { credentialRef: 'provider/nvidia/api-key', baseUrl: 'https://x' } }),
    ],
  });
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /sk-[A-Za-z0-9]{8,}/, 'no key material in the manifest');
  assert.doesNotMatch(serialized, /credentialRef/, 'no credential ref in the manifest');
  assert.doesNotMatch(serialized, /baseUrl/, 'no upstream base URL in the manifest');
});
