import { test } from 'node:test';
import assert from 'node:assert/strict';

import agentKind from '../core/capabilities/agent/kind.mjs';

test('agent cannot carry an xAI token or catalog', () => {
  const result = agentKind.validate({
    endpoint: 'http://127.0.0.1:8642',
    dependencies: [{ providerId: 'xai-main', role: 'primary' }],
    tokens: { access_token: 'forbidden' },
  });
  assert.equal(result.ok, false);
});

test('accepts an agent that only depends on a provider', () => {
  const result = agentKind.validate({
    endpoint: 'http://127.0.0.1:8642',
    dependencies: [{ providerId: 'xai-main', role: 'primary', modelId: 'grok-4' }],
  });
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('rejects credentials, catalog, and models on an agent', () => {
  for (const extra of [
    { credentials: { token: 'x' } },
    { catalog: { models: [] } },
    { models: ['grok'] },
    { apiKey: 'sk' },
  ]) {
    const result = agentKind.validate({
      endpoint: 'http://127.0.0.1:8642',
      dependencies: [{ providerId: 'xai-main', role: 'primary' }],
      ...extra,
    });
    assert.equal(result.ok, false, `expected rejection for ${Object.keys(extra)[0]}`);
  }
});
