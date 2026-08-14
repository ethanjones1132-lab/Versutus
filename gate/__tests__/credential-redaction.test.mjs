import { test } from 'node:test';
import assert from 'node:assert/strict';

import { redactSensitive } from '../core/credentials/redaction.mjs';

test('redacts credential fields and leaves non-secrets', () => {
  const redacted = redactSensitive({
    id: 'openai-main',
    apiKey: 'secret-value',
    token: 'secret-value',
    access_token: 'secret-value',
    nested: { refresh_token: 'secret-value', label: 'OpenAI API' },
  });
  assert.equal(redacted.id, 'openai-main');
  assert.equal(redacted.nested.label, 'OpenAI API');
  assert.equal(redacted.apiKey, '[redacted]');
  assert.equal(redacted.token, '[redacted]');
  assert.equal(redacted.access_token, '[redacted]');
  assert.equal(redacted.nested.refresh_token, '[redacted]');
});
