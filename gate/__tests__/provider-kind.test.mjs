import { test } from 'node:test';
import assert from 'node:assert/strict';

import providerKind from '../core/capabilities/provider/kind.mjs';

const valid = {
  flavor: 'openai',
  baseUrl: 'https://api.x.ai/v1',
  apiKeyEnv: 'XAI_API_KEY',
  models: ['grok-4'],
  streaming: true,
};

test('exposes the required kind contract fields', () => {
  assert.equal(providerKind.kind, 'provider');
  assert.equal(typeof providerKind.label, 'string');
  assert.equal(typeof providerKind.family, 'string');
  assert.ok(Array.isArray(providerKind.configFields));
});

test('accepts a well-formed config', () => {
  const result = providerKind.validate(valid);
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('rejects an unknown flavor, naming the field', () => {
  const result = providerKind.validate({ ...valid, flavor: 'banana' });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].field, 'flavor');
});

test('rejects a literal apiKey so secrets cannot reach the registry file', () => {
  const result = providerKind.validate({ ...valid, apiKeyEnv: undefined, apiKey: 'sk-live-abc123' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === 'apiKey'));
  assert.ok(result.errors.some((e) => e.field === 'apiKeyEnv'));
});

test('rejects an empty model list, naming the field', () => {
  const result = providerKind.validate({ ...valid, models: [] });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].field, 'models');
});

test('rejects a non-https base URL for a public provider', () => {
  const result = providerKind.validate({ ...valid, baseUrl: 'http://api.x.ai/v1' });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].field, 'baseUrl');
});

test('accepts http on loopback for local testing', () => {
  const result = providerKind.validate({ ...valid, baseUrl: 'http://127.0.0.1:9999/v1' });
  assert.equal(result.ok, true);
});

test('collects every violated rule, not just the first', () => {
  const result = providerKind.validate({ flavor: 'banana', models: [] });
  assert.equal(result.ok, false);
  const fields = result.errors.map((e) => e.field);
  assert.ok(fields.includes('flavor'));
  assert.ok(fields.includes('models'));
  assert.ok(fields.includes('apiKeyEnv'));
});

test('toManifestEntry produces the same shape the old manifest.providers[] entry had', () => {
  const instance = {
    id: 'claude',
    kind: 'provider',
    label: 'Claude',
    config: { flavor: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKeyEnv: 'ANTHROPIC_API_KEY', models: ['claude-opus-5'], streaming: true },
  };

  assert.deepEqual(providerKind.toManifestEntry(instance), {
    id: 'claude',
    label: 'Claude',
    basePath: '/p/claude',
    models: ['claude-opus-5'],
    capabilities: { chat: true, streaming: true },
  });
});

test('toManifestEntry never includes apiKeyEnv or baseUrl', () => {
  const instance = {
    id: 'claude',
    kind: 'provider',
    label: 'Claude',
    config: { flavor: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKeyEnv: 'ANTHROPIC_API_KEY', models: ['claude-opus-5'], streaming: true },
  };

  const serialized = JSON.stringify(providerKind.toManifestEntry(instance));
  assert.equal(serialized.includes('ANTHROPIC_API_KEY'), false);
  assert.equal(serialized.includes('api.anthropic.com'), false);
});

test('toManifestEntry defaults streaming to true when omitted', () => {
  const instance = { id: 'x', label: 'X', config: { models: ['m'] } };
  assert.equal(providerKind.toManifestEntry(instance).capabilities.streaming, true);
});

test('toManifestEntry respects streaming: false', () => {
  const instance = { id: 'x', label: 'X', config: { models: ['m'], streaming: false } };
  assert.equal(providerKind.toManifestEntry(instance).capabilities.streaming, false);
});

test('createHandlers returns no RPC methods — chat is served over the dedicated HTTP routes', () => {
  assert.deepEqual(providerKind.createHandlers({ id: 'claude' }), {});
});
