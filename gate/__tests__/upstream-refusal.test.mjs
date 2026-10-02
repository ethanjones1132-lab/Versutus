import { test } from 'node:test';
import assert from 'node:assert/strict';

import { backendUpstreamRefusal } from '../core/upstream-refusal.mjs';

// A turn that failed upstream comes back 200 with the failure as the assistant's
// whole text, and the Gate has to recognise it as the refusal it is: delivered
// as-is the app renders the Bot speaking the error, the non-streaming route
// answers 200 with `finish_reason: stop`, and model-health records a success for
// exactly the model that cannot answer (so it never leaves the picker).
//
// The shape is deliberately narrow — prose that merely mentions a status is a
// reply — but it has to survive a gateway that writes a sentence around the
// status instead of passing it through bare, which is what a custom endpoint that
// never answers comes back as.

test('a bare upstream status is a refusal, as it always was', () => {
  const text = 'HTTP 400: omen-alpha is not a valid model ID';
  assert.equal(backendUpstreamRefusal(text), text);
});

test('a status the gateway wrapped in its own sentence is still that refusal', () => {
  // The whole message is a claim about a failed call, and the status code is
  // inside it rather than at position 0 — which an anchored prefix match could
  // never see, so the turn was scored as a healthy answer.
  for (const text of [
    "Custom endpoint didn't answer after 5 attempts. Provider said: HTTP 404: not found",
    'Provider said: HTTP 502: upstream is unavailable',
    'The provider returned HTTP 429: rate limited',
  ]) {
    assert.equal(backendUpstreamRefusal(text), text, `expected a refusal: ${text}`);
  }
});

test('prose that mentions a status is a reply, and stays one', () => {
  for (const text of [
    'The host answered HTTP 400 and I retried with a backoff.',
    'A 404 means the route moved; here is the fix.',
    'I could not reproduce it — HTTP 500 was a one-off in June.',
    'the endpoint said nothing at all',
    '',
    undefined,
  ]) {
    assert.equal(backendUpstreamRefusal(text), null, `must stay a reply: ${String(text)}`);
  }
});

test('a status with nothing after it is not a refusal', () => {
  // The old shape required a body after the colon, and still does: a bare code
  // says the server reported a status, not what went wrong.
  assert.equal(backendUpstreamRefusal('HTTP 500'), null);
  assert.equal(backendUpstreamRefusal('Provider said: HTTP 500'), null);
});
