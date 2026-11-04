import { test } from 'node:test';
import assert from 'node:assert/strict';

import { backendUpstreamRefusal } from '../core/upstream-refusal.mjs';

// VS-004 (quality scan 2026-11-04): recognition must not rewrite a real reply.
// The scanned counterexample ends with a clause that reports a status; with a
// leading `[\s\S]*` in front of the lead-in, that clause was read as the whole
// claim and an ordinary answer was scored as a failed turn.

test('a genuine reply that reports or quotes a status stays a reply; the narrowed anchor keeps every accepted refusal', () => {
  // The status now has to START the message, or sit right behind a
  // start-anchored lead-in naming the upstream, so prose that reports a
  // status mid-answer is a reply again. The counterexample is pinned exactly
  // as it was scanned, and it fails against the unanchored
  // `[\s\S]*(provider|...) HTTP …` shape it names.
  assert.equal(
    backendUpstreamRefusal('I called the endpoint twice. The endpoint returned HTTP 200: OK on the first try.'),
    null,
    'a reported success inside an answer is prose, not a failed turn',
  );

  for (const text of [
    // The lead-in clause by itself does not make a refusal a refusal either:
    // what a named upstream RETURNED with a success code is the answer, not
    // the gateway wrapping a failure.
    'The endpoint returned HTTP 200: OK on the first try.',
    // A status inside quotation marks is quoted prose; and a status one line
    // down, after a real answer has begun, is part of it. Neither is the
    // whole-text claim that a refusal is.
    'The log line read: "The provider returned HTTP 429: rate limited", and that is the answer to your question.',
    [
      'I called the endpoint twice today.',
      'The first try the endpoint returned HTTP 429: rate limited, so I waited a moment and called again.',
      'The second try it answered with the full file.',
    ].join('\n'),
  ]) {
    assert.equal(backendUpstreamRefusal(text), null, `must stay a reply: ${String(text)}`);
  }

  // Every refusal shape the narrower anchor still has to catch: the bare
  // status with a body, and each wrapper the gateway has been seen writing
  // around one — the custom-endpoint sentence, the bare lead-in, and the
  // article-qualified one.
  for (const text of [
    'HTTP 400: omen-alpha is not a valid model ID',
    'HTTP 502: bad gateway from the handler',
    "Custom endpoint didn't answer after 5 attempts. Provider said: HTTP 404: not found",
    'Provider said: HTTP 502: upstream is unavailable',
    'The provider returned HTTP 429: rate limited',
  ]) {
    assert.equal(backendUpstreamRefusal(text), text, `expected a refusal: ${text}`);
  }
});
