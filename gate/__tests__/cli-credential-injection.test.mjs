import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCliEnvironment } from '../core/cli-environments/process-environment.mjs';

const request = {
  environmentId: 'opencode-local',
  runId: 'run-1',
  endpoints: { chat: 'http://127.0.0.1:8760/v1/chat/completions' },
};

const ambient = {
  PATH: 'C:\\Windows',
  NVIDIA_API_KEY: 'ambient-must-not-leak',
  OPENAI_API_KEY: 'ambient-must-not-leak',
  ANTHROPIC_AUTH_TOKEN: 'ambient-must-not-leak',
  SOME_SECRET: 'ambient-must-not-leak',
};

/**
 * Inheriting the operator's shell credentials into an agent CLI is how one
 * provider's key ends up used by another. Only keys deliberately bound to this
 * environment are passed, and they are passed explicitly — never by inheritance.
 */
test('ambient credentials are still stripped', () => {
  const env = buildCliEnvironment(ambient, request);
  for (const leaked of ['NVIDIA_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'SOME_SECRET']) {
    assert.equal(env[leaked], undefined, `${leaked} must not reach the CLI`);
  }
  assert.equal(env.PATH, 'C:\\Windows', 'benign variables still pass through');
});

test('a deliberately bound credential is injected', () => {
  const env = buildCliEnvironment(ambient, {
    ...request,
    credentials: { OPENCODE_API_KEY: 'bound-key', OPENCODE_SERVER_PASSWORD: 'server-pw' },
  });
  assert.equal(env.OPENCODE_API_KEY, 'bound-key');
  assert.equal(env.OPENCODE_SERVER_PASSWORD, 'server-pw');
  // and the ambient ones are still gone
  assert.equal(env.NVIDIA_API_KEY, undefined);
});

test('a bound credential wins over an ambient variable of the same name', () => {
  const env = buildCliEnvironment(
    { ...ambient, OPENCODE_API_KEY: 'ambient-stale' },
    { ...request, credentials: { OPENCODE_API_KEY: 'bound-key' } },
  );
  assert.equal(env.OPENCODE_API_KEY, 'bound-key');
});

test('the invocation token is still issued alongside injected credentials', () => {
  const env = buildCliEnvironment(ambient, { ...request, credentials: { OPENCODE_API_KEY: 'k' } });
  assert.ok(env.VERSUTUS_CLI_INVOCATION_TOKEN);
  assert.equal(env.VERSUTUS_GATE_CHAT, request.endpoints.chat);
});

test('empty or non-string credential values are ignored rather than passed as "undefined"', () => {
  const env = buildCliEnvironment(ambient, {
    ...request,
    credentials: { EMPTY: '', MISSING: undefined, NUMERIC: 42, GOOD: 'yes' },
  });
  assert.equal(env.EMPTY, undefined);
  assert.equal(env.MISSING, undefined);
  assert.equal(env.NUMERIC, undefined);
  assert.equal(env.GOOD, 'yes');
});
