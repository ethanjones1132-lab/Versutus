import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  issueInvocationToken,
  verifyInvocationToken,
} from '../core/cli-environments/invocation-tokens.mjs';

const request = {
  environmentId: 'hermes-local',
  runId: 'run-1',
  providerRef: { providerId: 'openai-main', modelId: 'gpt-test' },
  audience: 'versutus-gate',
  endpoints: { chat: 'http://127.0.0.1:8760/v1/chat/completions' },
};

test('issued tokens verify for the bound audience and reject replay', () => {
  const issued = issueInvocationToken(request, { now: 1_000, ttlMs: 60_000 });
  const first = verifyInvocationToken(issued.token, {
    audience: 'versutus-gate',
    runId: 'run-1',
    now: 1_000,
  });
  assert.equal(first.ok, true);
  assert.equal(first.claims.providerId, 'openai-main');
  const replay = verifyInvocationToken(issued.token, {
    audience: 'versutus-gate',
    runId: 'run-1',
    now: 1_001,
  });
  assert.equal(replay.ok, false);
  assert.match(replay.code, /replay/i);
});

test('expired or wrong-audience tokens fail closed', () => {
  const issued = issueInvocationToken(request, { now: 1_000, ttlMs: 10 });
  assert.equal(verifyInvocationToken(issued.token, {
    audience: 'other',
    runId: 'run-1',
    now: 1_000,
  }).ok, false);
  assert.equal(verifyInvocationToken(issued.token, {
    audience: 'versutus-gate',
    runId: 'run-1',
    now: 2_000,
  }).ok, false);
});
