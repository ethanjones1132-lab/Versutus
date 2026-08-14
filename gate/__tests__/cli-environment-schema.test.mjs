import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateCliEnvironmentRegistration } from '../core/cli-environments/schema.mjs';
import { validEnvironment } from './fixtures/cli-environment.mjs';

test('rejects provider state on a CLI environment', () => {
  const result = validateCliEnvironmentRegistration(validEnvironment({ models: ['gpt'] }));
  assert.equal(result.ok, false);
});

test('rejects credentials, tokens, catalog, and provider auth fields', () => {
  for (const extra of [
    { credentials: { token: 'x' } },
    { tokens: { access_token: 'x' } },
    { catalog: { models: [] } },
    { credentialRef: 'provider/x/api-key' },
    { oauthProfileId: 'openai' },
  ]) {
    const result = validateCliEnvironmentRegistration(validEnvironment(extra));
    assert.equal(result.ok, false, `expected rejection for ${Object.keys(extra)[0]}`);
  }
});

test('rejects an unknown schema version', () => {
  const result = validateCliEnvironmentRegistration(validEnvironment({ schemaVersion: 2 }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.field === 'schemaVersion'));
});

test('accepts a well-formed CLI environment', () => {
  const result = validateCliEnvironmentRegistration(validEnvironment());
  assert.deepEqual(result, { ok: true, errors: [] });
});
