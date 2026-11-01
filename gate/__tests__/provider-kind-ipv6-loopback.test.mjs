import { test } from 'node:test';
import assert from 'node:assert/strict';

import providerKind from '../core/capabilities/provider/kind.mjs';

// Minimal valid provider config; only baseUrl changes between cases.
const minimal = {
  flavor: 'openai',
  baseUrl: 'https://api.example.com/v1',
  apiKeyEnv: 'PROVIDER_API_KEY',
  models: ['model-a'],
};

test('accepts http on bracketed IPv6 loopback', () => {
  const result = providerKind.validate({ ...minimal, baseUrl: 'http://[::1]:11434' });
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('accepts http on IPv4 loopback with a dead port', () => {
  const result = providerKind.validate({ ...minimal, baseUrl: 'http://127.0.0.1:9' });
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('accepts http on localhost with a dead port', () => {
  const result = providerKind.validate({ ...minimal, baseUrl: 'http://localhost:9' });
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('still rejects http on a non-loopback host with must use https', () => {
  const result = providerKind.validate({ ...minimal, baseUrl: 'http://example.com' });
  assert.equal(result.ok, false);
  const baseUrlError = result.errors.find((e) => e.field === 'baseUrl');
  assert.ok(baseUrlError);
  assert.match(baseUrlError.message, /must use https/);
});

test('accepts https on bracketed IPv6 loopback', () => {
  const result = providerKind.validate({ ...minimal, baseUrl: 'https://[::1]:443' });
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('still rejects a literal apiKey so secrets cannot reach the registry file', () => {
  const result = providerKind.validate({ ...minimal, baseUrl: 'http://[::1]:11434', apiKey: 'literal' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === 'apiKey'));
});

test('still rejects an unknown flavor alongside a loopback base URL', () => {
  const result = providerKind.validate({ ...minimal, baseUrl: 'http://[::1]:11434', flavor: 'banana' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === 'flavor'));
});

test('still rejects an empty model list alongside a loopback base URL', () => {
  const result = providerKind.validate({ ...minimal, baseUrl: 'http://[::1]:11434', models: [] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === 'models'));
});
