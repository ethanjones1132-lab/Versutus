import { test } from 'node:test';
import assert from 'node:assert/strict';

import { issueInvocationToken, verifyInvocationToken } from '../core/cli-environments/invocation-tokens.mjs';
import { buildCliEnvironment } from '../core/cli-environments/process-environment.mjs';

/**
 * A run that needs no model — `status`, a probe, a read-only inspection — has no
 * provider to reference. Dereferencing providerRef unconditionally turned that
 * into "Cannot read properties of undefined (reading 'providerId')" surfaced as
 * a 409, which reads as a Gate fault rather than a missing argument.
 */
test('a run without a providerRef issues a usable token', () => {
  const issued = issueInvocationToken({
    environmentId: 'opencode-local',
    runId: 'run-1',
    endpoints: { chat: 'http://127.0.0.1:8760/v1/chat/completions' },
  });
  assert.ok(issued.token);
  assert.equal(issued.claims.providerId, undefined);
  assert.equal(issued.claims.environmentId, 'opencode-local');
  const verified = verifyInvocationToken(issued.token, { runId: 'run-1' });
  assert.ok(verified.ok ?? verified, 'token should verify');
});

test('a providerRef still travels in the token when supplied', () => {
  const issued = issueInvocationToken({
    environmentId: 'opencode-local',
    runId: 'run-2',
    providerRef: { providerId: 'opencode-zen', modelId: 'minimax-m3' },
    endpoints: { chat: 'http://127.0.0.1:8760/v1/chat/completions' },
  });
  assert.equal(issued.claims.providerId, 'opencode-zen');
  assert.equal(issued.claims.modelId, 'minimax-m3');
});

test('building the child environment tolerates a missing providerRef', () => {
  const child = buildCliEnvironment(
    { PATH: 'C:\\Windows', NVIDIA_API_KEY: 'must-not-leak' },
    { environmentId: 'e', runId: 'r', endpoints: { chat: 'http://127.0.0.1/v1/chat/completions' } },
  );
  assert.ok(child.VERSUTUS_CLI_INVOCATION_TOKEN);
  assert.equal(child.NVIDIA_API_KEY, undefined, 'provider credentials must never reach a CLI');
});
