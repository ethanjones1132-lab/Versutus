import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildManifest } from '../core/manifest.mjs';

const providers = [
  {
    id: 'claude',
    label: 'Claude',
    config: {
      flavor: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      models: ['claude-opus-5'],
      capabilities: { chat: true, streaming: true },
    },
  },
];

test('declares the manifest spec version and kind', () => {
  const manifest = buildManifest({ name: "Ethan's Gate", providers });
  assert.equal(manifest.manifest, 'versutus-gateway/v1');
  assert.equal(manifest.kind, 'versutus-gate');
  assert.equal(manifest.name, "Ethan's Gate");
});

test('advertises design-spec transport, endpoints, and capabilities', () => {
  const manifest = buildManifest({ name: 'Gate', providers });
  assert.deepEqual(manifest.transport, { primary: 'http' });
  assert.deepEqual(manifest.endpoints, {
    health: '/health',
    models: '/v1/models',
    chat: '/v1/chat/completions',
  });
  assert.deepEqual(manifest.capabilities, { chat: true, models: true });
});

test('advertises each provider with its base path and capabilities', () => {
  const manifest = buildManifest({ name: 'Gate', providers });
  assert.equal(manifest.providers.length, 1);
  assert.deepEqual(manifest.providers[0], {
    id: 'claude',
    label: 'Claude',
    basePath: '/p/claude',
    models: ['claude-opus-5'],
    capabilities: { chat: true, streaming: true },
  });
});

test('never leaks the API key env var name or base URL to the client', () => {
  const manifest = buildManifest({ name: 'Gate', providers });
  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes('ANTHROPIC_API_KEY'), false);
  assert.equal(serialized.includes('api.anthropic.com'), false);
});

test('advertises the signed access path so the app can pair', () => {
  const manifest = buildManifest({ name: 'Gate', providers });
  assert.equal(manifest.auth.grantPath, '/.well-known/gateway/access');
  assert.ok(manifest.auth.schemes.includes('bearer'));
});

test('serves a valid manifest with no providers configured', () => {
  const manifest = buildManifest({ name: 'Gate', providers: [] });
  assert.deepEqual(manifest.providers, []);
  assert.equal(manifest.manifest, 'versutus-gateway/v1');
});
