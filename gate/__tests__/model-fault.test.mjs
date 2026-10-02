import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isGateInternalReason, isModelFault } from '../core/model-fault.mjs';

// The model-health table hides a model for six hours after two failed turns, so
// what counts as a failed turn decides whether an operator's models are there.
// A defect in the Gate is not evidence about a model: on 2026-10-02 `call()`
// read OpenCode's empty 204 with `response.json()`, the turn reported
// `Unexpected end of JSON input`, and two of those verdicts hid
// `opencode-go/longcat-2.5-preview-free` and `opencode/fledge-alpha-free` for
// the day. A verdict is only ever evidence about the model or its provider.

test('a refusal, a stall and a quota answer from the model are evidence about it', () => {
  // Every message here was read off this host's own turns.
  assert.equal(isModelFault(new Error('HTTP 404: No endpoints available for openrouter/free')), true);
  assert.equal(
    isModelFault(new Error("Custom endpoint didn't answer after 5 attempts. Provider said: HTTP 404")),
    true,
  );
  assert.equal(isModelFault(new Error('opencode: kilo-auto/free did not answer within 60 s')), true);
  assert.equal(isModelFault(new Error('MissingSessionID')), true);
  assert.equal(isModelFault(new Error('not a valid model')), true);
  assert.equal(isModelFault(new Error('HTTP 429: rate limited')), true);
  assert.equal(isModelFault(new Error('the provider quota is exhausted')), true);
  assert.equal(isModelFault(new Error('model_not_available')), true);
  // An upstream failure OpenCode folded into `info.error` of a 200 reply.
  assert.equal(
    isModelFault(Object.assign(new Error('opencode: Rate Limit Exceeded'), { name: 'APIError' })),
    true,
  );
  // An empty turn: the model completed and said nothing (the app's empty_turn).
  assert.equal(
    isModelFault(new Error('The backend completed the turn with no assistant content.')),
    true,
  );
});

test("the Gate's own faults are not evidence about the model", () => {
  assert.equal(isModelFault(new SyntaxError('Unexpected end of JSON input')), false);
  assert.equal(isModelFault(new TypeError('x is not a function')), false);
  assert.equal(isModelFault(new Error('Unexpected end of JSON input')), false);
  assert.equal(isModelFault(new Error("Unexpected token '}', ...")), false);
  assert.equal(isModelFault(new Error('Cannot read properties of undefined (reading id)')), false);
  assert.equal(
    isModelFault(new Error('opencode: could not reach http://127.0.0.1:4096/session/s/message (fetch failed)')),
    false,
  );
  assert.equal(isModelFault(new Error('opencode server did not become reachable within 30000ms')), false);
  assert.equal(isModelFault(new Error('hermes server exited with code 2 before becoming reachable')), false);
  assert.equal(isModelFault(new Error('backend_unavailable')), false);
  assert.equal(
    isModelFault(Object.assign(new Error('No backend that could serve listBots is answering'), {
      code: 'backend_unavailable',
    })),
    false,
  );
  // A Node/system code says the transport failed, whoever asked.
  assert.equal(isModelFault(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), false);
  assert.equal(isModelFault(Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' })), false);
  assert.equal(
    isModelFault(Object.assign(new Error('socket hang up'), { code: 'UND_ERR_SOCKET' })),
    false,
  );
});

test('an instance the Gate throws on its own bugs is never a model fault', () => {
  for (const error of [new RangeError('index out of range'), new ReferenceError('x is not defined')]) {
    assert.equal(isModelFault(error), false, error.name);
  }
  // A refusal wearing a TypeError is still the Gate's own parse failure, not the
  // provider: the fault is what produced the message.
  assert.equal(isModelFault(new TypeError('HTTP 404: No endpoints available')), false);
});

test('nothing else is evidence: unsure is never a verdict against the model', () => {
  for (const message of ['something odd', 'the turn did not complete', '']) {
    assert.equal(isModelFault(new Error(message)), false, message);
  }
  assert.equal(isModelFault(undefined), false);
  assert.equal(isModelFault(null), false);
  assert.equal(isModelFault('a string, not an error'), false);
});

test('a stored reason is recognised from its text alone', () => {
  // model-health.json holds reasons, not errors: the Gate's own signatures are
  // what has to be recognisable there so a wrong verdict can heal itself.
  assert.equal(isGateInternalReason('Unexpected end of JSON input'), true);
  assert.equal(isGateInternalReason('opencode: could not reach http://127.0.0.1:4096 (fetch failed)'), true);
  assert.equal(isGateInternalReason('hermes server exited with code 2 before becoming reachable'), true);
  assert.equal(isGateInternalReason('HTTP 400: MissingSessionID'), false);
  assert.equal(isGateInternalReason('The backend completed the turn with no assistant content'), false);
  assert.equal(isGateInternalReason(undefined), false);
});

test('a missing Gate-side session is never evidence about a model', () => {
  // 2026-10-02: the thread tap searched the wrong environment and the Gate answered
  // `Session not found`. A lookup of the Gate's own session says nothing about
  // whether the model can answer, so it must never count toward hiding one.
  assert.equal(isModelFault(new Error('Session not found: api_1790918481_9a2e6f57')), false);
  assert.equal(isModelFault(new Error('hermes: session not found')), false);
});
