import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateProviderConfig } from '../core/config.mjs';

const valid = {
  flavor: 'openai',
  baseUrl: 'https://api.x.ai/v1',
  apiKeyEnv: 'XAI_API_KEY',
  models: ['grok-4'],
  capabilities: { chat: true, streaming: true },
};

test('accepts a well-formed config', () => {
  const result = validateProviderConfig('grok', valid);
  assert.equal(result.ok, true);
});

test('rejects an unknown flavor', () => {
  const result = validateProviderConfig('grok', { ...valid, flavor: 'banana' });
  assert.equal(result.ok, false);
  assert.match(result.error, /flavor/);
});

test('rejects a literal API key so secrets cannot reach the manifest', () => {
  const result = validateProviderConfig('grok', {
    ...valid,
    apiKeyEnv: undefined,
    apiKey: 'sk-live-abc123',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /apiKeyEnv/);
});

test('rejects an empty model list', () => {
  const result = validateProviderConfig('grok', { ...valid, models: [] });
  assert.equal(result.ok, false);
  assert.match(result.error, /models/);
});

test('rejects a non-https base URL for a public provider', () => {
  const result = validateProviderConfig('grok', { ...valid, baseUrl: 'http://api.x.ai/v1' });
  assert.equal(result.ok, false);
  assert.match(result.error, /https/);
});

test('names the offending field so a model can self-correct', () => {
  const result = validateProviderConfig('grok', { ...valid, models: 'grok-4' });
  assert.equal(result.ok, false);
  assert.match(result.error, /models/);
});
