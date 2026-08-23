import { classifyRunFailure, describeRunFailure, formatRunFailure } from '@/lib/gateway/run-failures';

// Every raw string below is one the Gate actually emits — pinned verbatim so
// a Gate wording change shows up here as a test failure instead of silently
// degrading the phone back to `Error: <raw>`.

test('missing listen key classifies from the Gate refusal', () => {
  expect(classifyRunFailure('bot "echo" has no API_SERVER_KEY')).toBe('listen_key_missing');
});

test('default-key refusal wins over its API_SERVER_KEY mention (ordering pin)', () => {
  const gate = 'bot "echo" still uses the default listen key; /p/echo/ rejects it — give the profile its own API_SERVER_KEY';
  expect(classifyRunFailure(gate)).toBe('default_key_refused');
});

test('multiplex-off failure names ADR 0008 state and host command', () => {
  const view = describeRunFailure('Enable multiplex on the host: set gateway.multiplex_profiles true');
  expect(view.kind).toBe('multiplex_disabled');
  expect(view.title).toBe('Multiplex is off');
  expect(view.next).toContain('gateway.multiplex_profiles true');
});

test('unknown bot sends the operator back to the roster', () => {
  const view = describeRunFailure('unknown bot "ghost"');
  expect(view.kind).toBe('unknown_bot');
  expect(view.next).toMatch(/roster/i);
});

test('spawn failures read as an unreachable environment, not a network blip', () => {
  const exited = 'hermes server exited with code 1 before becoming reachable.';
  expect(classifyRunFailure(exited)).toBe('environment_unreachable');

  const vanished = 'workspace directory disappeared before the task could start: C:\\work\\pilot';
  expect(classifyRunFailure(vanished)).toBe('environment_unreachable');

  expect(classifyRunFailure('spawn ENOENT')).toBe('environment_unreachable');
});

test('backend misconfigurations count as environment failures', () => {
  expect(classifyRunFailure('Hermes home is not configured')).toBe('environment_unreachable');
  expect(classifyRunFailure('This backend does not implement bots')).toBe('environment_unreachable');
});

test('the maxRunSeconds kill names the limit and the fix', () => {
  const gate =
    'task exceeded its 60s time limit and was stopped — raise or remove lifecycle.maxRunSeconds on the environment to allow longer tasks';
  const view = describeRunFailure(gate);
  expect(view.kind).toBe('time_limit');
  expect(view.title).toBe('Task hit its time limit');
  expect(view.next).toContain('maxRunSeconds');
});

test('expired authorization windows classify as expired', () => {
  expect(classifyRunFailure('invocation token expired')).toBe('expired');
  const view = describeRunFailure('job expired');
  expect(view.title).toBe('Task expired');
  expect(view.next).toMatch(/resubmit/i);
});

test('generic text stays generic and formatRunFailure falls back to null', () => {
  expect(classifyRunFailure('internal server error')).toBe('generic');
  expect(describeRunFailure('internal server error').next).toBeUndefined();
  expect(formatRunFailure('connection refused')).toBeNull();
});

test('formatRunFailure composes verdict, verbatim cause, and fix without doubled punctuation', () => {
  const composed = formatRunFailure('bot "echo" has no API_SERVER_KEY');
  expect(composed).toBe(
    'Bot has no listen key — bot "echo" has no API_SERVER_KEY. Set API_SERVER_KEY in the profile\'s .env on the host, then retry.',
  );

  // Cause already ends in a period: no "..".
  const punctuated = formatRunFailure('hermes server exited with code 1 before becoming reachable.');
  expect(punctuated).not.toContain('..');
  expect(punctuated?.startsWith('Environment unreachable — hermes server exited with code 1 before becoming reachable. Check')).toBe(true);
});
