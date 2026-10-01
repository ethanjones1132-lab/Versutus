import { test } from 'node:test';
import assert from 'node:assert/strict';

import { redactSensitive, redactSensitiveText } from '../core/credentials/redaction.mjs';

test('redacts camelCase, snake_case and kebab-case variants at depth', () => {
  const redacted = redactSensitive({
    apiKey: 'secret',
    access_token: 'secret',
    'refresh-token': 'secret',
    idToken: 'secret',
    clientSecret: 'secret',
    nested: {
      privateKey: 'secret',
      sessionToken: 'secret',
      'x-api-key': 'secret',
      authorization: 'secret',
      bearer: 'secret',
    },
  });
  assert.equal(redacted.apiKey, '[redacted]');
  assert.equal(redacted.access_token, '[redacted]');
  assert.equal(redacted['refresh-token'], '[redacted]');
  assert.equal(redacted.idToken, '[redacted]');
  assert.equal(redacted.clientSecret, '[redacted]');
  assert.equal(redacted.nested.privateKey, '[redacted]');
  assert.equal(redacted.nested.sessionToken, '[redacted]');
  assert.equal(redacted.nested['x-api-key'], '[redacted]');
  assert.equal(redacted.nested.authorization, '[redacted]');
  assert.equal(redacted.nested.bearer, '[redacted]');
});

test('redacts inside arrays', () => {
  const redacted = redactSensitive([
    { apiKey: 'secret', label: 'a' },
    { token: 'secret', label: 'b' },
  ]);
  assert.equal(redacted[0].apiKey, '[redacted]');
  assert.equal(redacted[0].label, 'a');
  assert.equal(redacted[1].token, '[redacted]');
  assert.equal(redacted[1].label, 'b');
});

test('cyclic input does not throw', () => {
  const input = { label: 'a' };
  input.self = input;
  const redacted = redactSensitive(input);
  assert.equal(redacted.label, 'a');
  assert.equal(redacted.self, '[redacted]');
});

test('non-sensitive keys are untouched', () => {
  const redacted = redactSensitive({
    id: 'openai-main',
    label: 'OpenAI API',
    baseUrl: 'https://api.openai.com',
    nested: { models: ['gpt-4'] },
  });
  assert.equal(redacted.id, 'openai-main');
  assert.equal(redacted.label, 'OpenAI API');
  assert.equal(redacted.baseUrl, 'https://api.openai.com');
  assert.deepEqual(redacted.nested.models, ['gpt-4']);
});

test('redactSensitiveText removes Bearer tokens', () => {
  const redacted = redactSensitiveText('Authorization: Bearer sk-abc123def456ghi789jkl');
  assert.equal(redacted, 'Authorization: [redacted]');
});

test('redactSensitiveText removes Basic tokens case-insensitively', () => {
  const redacted = redactSensitiveText('header: basic dXNlcjpwYXNzd29yZA==');
  assert.equal(redacted, 'header: [redacted]');
});

test('redactSensitiveText removes quoted JSON keys', () => {
  const redacted = redactSensitiveText('{"apiKey": "sk-abc123def456ghi789jkl"}');
  assert.equal(redacted, '{"apiKey": "[redacted]"}');
});

test('redactSensitiveText removes unquoted JSON keys', () => {
  const redacted = redactSensitiveText('api_key=supersecretvalue123');
  assert.equal(redacted, 'api_key=[redacted]');
});

test('redactSensitiveText removes literal secrets', () => {
  const redacted = redactSensitiveText('the password is hunter2hunter2 ok', ['hunter2hunter2']);
  assert.equal(redacted, 'the password is [redacted] ok');
});

test('redactSensitiveText removes literal secrets containing regex metacharacters', () => {
  assert.equal(
    redactSensitiveText('the key is ya29.abcdefghijklmnop end', ['ya29.abcdefghijklmnop']),
    'the key is [redacted] end',
  );
  assert.equal(
    redactSensitiveText('using sk-proj.abc-DEF_1234567890 failed', ['sk-proj.abc-DEF_1234567890']),
    'using [redacted] failed',
  );
  assert.equal(
    redactSensitiveText('rejected with ab+cd=efghijklmnop today', ['ab+cd=efghijklmnop']),
    'rejected with [redacted] today',
  );
  assert.equal(
    redactSensitiveText('oops [abc]def.ghi happened', ['[abc]def.ghi']),
    'oops [redacted] happened',
  );
});

test('redactSensitiveText removes a JWT-shaped literal secret', () => {
  const jwt = 'eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM';
  const redacted = redactSensitiveText(`jwt ${jwt} expired`, [jwt]);
  assert.equal(redacted, 'jwt [redacted] expired');
});

test('redactSensitiveText leaves ordinary text alone', () => {
  const redacted = redactSensitiveText('hello world, this is fine');
  assert.equal(redacted, 'hello world, this is fine');
});
