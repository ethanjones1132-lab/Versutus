import assert from 'node:assert/strict';
import test from 'node:test';

import { unresolvedBackendResponse } from '../core/backend-resolution.mjs';

test('with every backend up, a method nobody implements is honestly unsupported', () => {
  const { status, body } = unresolvedBackendResponse('listBots', []);
  assert.equal(status, 501);
  assert.equal(body.error.code, 'backend_unsupported');
  assert.match(body.error.message, /No attached backend implements listBots/);
});

test('a backend that failed to start makes the answer "unavailable", naming it and why', () => {
  // On 2026-09-16 Hermes' own gateway was stuck in a startup loop, so the Gate
  // could not attach to :8642. The lookup swallowed that and answered 501 "No
  // attached backend implements listBots" — a claim about capability when the
  // truth was an outage, and it sent the diagnosis the wrong way for an hour.
  const { status, body } = unresolvedBackendResponse('listBots', [
    { id: 'hermes-local', error: new Error('hermes server did not become reachable at http://127.0.0.1:8642') },
  ]);
  assert.equal(status, 503);
  assert.equal(body.error.code, 'backend_unavailable');
  assert.match(body.error.message, /hermes-local/);
  assert.match(body.error.message, /did not become reachable/);
  assert.match(body.error.message, /listBots/);
});

test('a startup error never carries a credential into the response', () => {
  const { body } = unresolvedBackendResponse('listBots', [
    { id: 'hermes-local', error: new Error('401 from upstream with Authorization: Bearer sk-live-abc123def456') },
  ]);
  assert.equal(body.error.message.includes('sk-live-abc123def456'), false);
  assert.match(body.error.message, /\[redacted\]/);
});

test('a runaway error message is bounded', () => {
  const { body } = unresolvedBackendResponse('listBots', [
    { id: 'hermes-local', error: new Error('x'.repeat(5000)) },
  ]);
  assert.ok(body.error.message.length < 600);
});
