import {
  classifyRunFailure,
  describeRunFailure,
  formatRunFailure,
} from '@/lib/gateway/run-failures';
import { errorCodeFromHttpBody, messageFromHttpErrorBody } from '@/lib/gateway/http-error-body';

// The Gate's run-events route answers a replay miss fail-honestly since
// d1acb9d: 404 with {error:{code:'run_events_unavailable', message}}. The
// clients carry that code forward (prefixed) instead of discarding it into a
// bare "HTTP 404", and this classifier turns the composite into the same
// desktop-parity verdict every other run failure gets. The wire shape below
// is anchored to gate/core/server.mjs — a wording change on the Gate shows up
// here as a failure instead of silently degrading a phone operator's error.

test('the Gate\'s replay-miss code classifies as its own kind', () => {
  expect(classifyRunFailure('run_events_unavailable: run not found')).toBe('run_events_unavailable');
});

test('the code anchor beats an upstream reason that names another state', () => {
  // The upstream's 404 text is its own; it may legitimately contain words
  // this classifier knows ("expired", "environment …"). The code is the
  // Gate's dominant signal, so it must win regardless.
  expect(classifyRunFailure('run_events_unavailable: run expired')).toBe('run_events_unavailable');
  expect(classifyRunFailure('run_events_unavailable: environment not_installed')).toBe(
    'run_events_unavailable',
  );
});

test('a replay refusal describes honestly with the raw cause kept', () => {
  const raw = 'run_events_unavailable: nothing to read yet';
  const view = describeRunFailure(raw);
  expect(view.kind).toBe('run_events_unavailable');
  expect(view.title).toBe('Replay unavailable');
  expect(view.cause).toBe(raw);
  expect(view.next).toMatch(/Recent runs/);
});

test('the replay verdict reads as one honest line for the sheet', () => {
  const oneLiner = formatRunFailure('run_events_unavailable: run not found');
  expect(oneLiner).not.toBeNull();
  expect(oneLiner!).toMatch(/^Replay unavailable — /);
  expect(oneLiner!).toMatch(/Recent runs/);
});

test('a bare HTTP status stays generic — no misfire on raw proxies', () => {
  expect(classifyRunFailure('HTTP 404')).toBe('generic');
  expect(describeRunFailure('HTTP 404').next).toBeUndefined();
});

test('the Gate\'s machine-readable code is extracted from its error body', () => {
  const body = JSON.stringify({ error: { message: 'run not found', code: 'run_events_unavailable' } });
  expect(errorCodeFromHttpBody(body)).toBe('run_events_unavailable');
  // Non-JSON and non-object bodies carry no code — the old "HTTP 404" fallback
  // must survive those untouched.
  expect(errorCodeFromHttpBody('gateway refused')).toBeUndefined();
  expect(errorCodeFromHttpBody(JSON.stringify({ error: 'gateway refused' }))).toBeUndefined();
  expect(errorCodeFromHttpBody('')).toBeUndefined();
});

test('the client shaping contract lands the composite in the replay kind', () => {
  // The exact 404 body the Gate emits (server.mjs run-events route). The
  // client throws `run_events_unavailable: <message>` from this body, and the
  // classifier must map that composite back to the same kind.
  const body = JSON.stringify({ error: { message: 'run 42 not found', code: 'run_events_unavailable' } });
  const message = messageFromHttpErrorBody(body, 404);
  const code = errorCodeFromHttpBody(body);
  expect(message).toBe('run 42 not found');
  expect(code).toBe('run_events_unavailable');
  expect(classifyRunFailure(`run_events_unavailable: ${message}`)).toBe('run_events_unavailable');
});

test('an empty error body still falls back to the bare status', () => {
  // A non-Gate refusal (proxy hiccup, dead listener) has no JSON: keep the
  // precise old behavior rather than inventing a message.
  expect(messageFromHttpErrorBody('', 404)).toBe('HTTP 404');
});