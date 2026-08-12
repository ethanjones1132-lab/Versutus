import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildManifest } from '../core/manifest.mjs';

const capabilityKinds = [
  { id: 'provider', label: 'Model provider', family: 'provider', configFields: [{ key: 'flavor', label: 'Flavor', type: 'enum', required: true, options: ['openai', 'anthropic', 'custom'] }] },
];

const capabilityInstances = [
  {
    id: 'claude',
    kind: 'provider',
    label: 'Claude',
    family: 'provider',
    manifestEntry: { id: 'claude', label: 'Claude', basePath: '/p/claude', models: ['claude-opus-5'], capabilities: { chat: true, streaming: true } },
  },
];

test('declares the manifest spec version and kind', () => {
  const manifest = buildManifest({ name: "Ethan's Gate", capabilityKinds, capabilityInstances });
  assert.equal(manifest.manifest, 'versutus-gateway/v1');
  assert.equal(manifest.kind, 'versutus-gate');
  assert.equal(manifest.name, "Ethan's Gate");
});

test('advertises design-spec transport, endpoints, and capabilities', () => {
  const manifest = buildManifest({ name: 'Gate', capabilityKinds, capabilityInstances });
  assert.deepEqual(manifest.transport, { primary: 'http' });
  assert.deepEqual(manifest.endpoints, {
    health: '/health',
    models: '/v1/models',
    chat: '/v1/chat/completions',
  });
  assert.deepEqual(manifest.capabilities, { chat: true, models: true });
});

test('derives providers[] from capabilityInstances of kind provider, in the legacy shape', () => {
  const manifest = buildManifest({ name: 'Gate', capabilityKinds, capabilityInstances });
  assert.equal(manifest.providers.length, 1);
  assert.deepEqual(manifest.providers[0], {
    id: 'claude',
    label: 'Claude',
    basePath: '/p/claude',
    models: ['claude-opus-5'],
    capabilities: { chat: true, streaming: true },
  });
});

test('excludes non-provider instances from the legacy providers[] array', () => {
  const mixed = [
    ...capabilityInstances,
    { id: 'standup', kind: 'cron', label: 'Standup', family: 'cron', manifestEntry: { id: 'standup', schedule: '0 9 * * 1-5' } },
  ];
  const manifest = buildManifest({ name: 'Gate', capabilityKinds, capabilityInstances: mixed });
  assert.equal(manifest.providers.length, 1);
  assert.equal(manifest.providers[0].id, 'claude');
});

test('advertises capabilityKinds and capabilityInstances verbatim', () => {
  const manifest = buildManifest({ name: 'Gate', capabilityKinds, capabilityInstances });
  assert.deepEqual(manifest.capabilityKinds, capabilityKinds);
  assert.deepEqual(manifest.capabilityInstances, capabilityInstances);
});

test('never leaks the API key env var name or base URL to the client', () => {
  const manifest = buildManifest({ name: 'Gate', capabilityKinds, capabilityInstances });
  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes('ANTHROPIC_API_KEY'), false);
  assert.equal(serialized.includes('api.anthropic.com'), false);
});

test('advertises the signed access path so the app can pair', () => {
  const manifest = buildManifest({ name: 'Gate', capabilityKinds, capabilityInstances });
  assert.equal(manifest.auth.grantPath, '/.well-known/gateway/access');
  assert.ok(manifest.auth.schemes.includes('bearer'));
});

test('serves a valid manifest with nothing configured', () => {
  const manifest = buildManifest({ name: 'Gate', capabilityKinds: [], capabilityInstances: [] });
  assert.deepEqual(manifest.providers, []);
  assert.deepEqual(manifest.capabilityKinds, []);
  assert.deepEqual(manifest.capabilityInstances, []);
  assert.equal(manifest.manifest, 'versutus-gateway/v1');
});
