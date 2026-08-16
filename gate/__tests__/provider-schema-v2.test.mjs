import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateProviderRegistration } from '../core/providers/schema.mjs';

function validApiKey(overrides = {}) {
  return {
    schemaVersion: 2,
    kind: 'provider',
    id: 'openai-main',
    label: 'OpenAI API',
    providerType: 'openai',
    enabled: true,
    registration: {
      mode: 'api_key',
      protocol: 'openai_chat',
      baseUrl: 'https://api.openai.com/v1',
      credentialRef: 'provider/openai-main/api-key',
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 120000 },
    ...overrides,
  };
}

test('rejects mixed provider registration modes', () => {
  const result = validateProviderRegistration({
    schemaVersion: 2,
    kind: 'provider',
    id: 'mixed',
    label: 'Mixed',
    providerType: 'openai',
    enabled: true,
    registration: {
      mode: 'oauth',
      protocol: 'openai_responses',
      resourceBaseUrl: 'https://api.openai.com/v1',
      oauthProfileId: 'openai',
      credentialRef: 'must-not-coexist',
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 120000 },
  });
  assert.equal(result.ok, false);
});

test('rejects an unknown schema version', () => {
  const result = validateProviderRegistration(validApiKey({ schemaVersion: 99 }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.field === 'schemaVersion'));
});

test('rejects an unknown protocol', () => {
  const result = validateProviderRegistration(
    validApiKey({
      registration: {
        mode: 'api_key',
        protocol: 'invented_rpc',
        baseUrl: 'https://api.openai.com/v1',
        credentialRef: 'provider/openai-main/api-key',
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.field === 'registration.protocol'));
});

test('accepts a well-formed api_key registration', () => {
  const result = validateProviderRegistration(validApiKey());
  assert.deepEqual(result, { ok: true, errors: [] });
});
