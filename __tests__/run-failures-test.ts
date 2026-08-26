import { classifyRunFailure, describeRunFailure, formatRunFailure, routingFailureView } from '@/lib/gateway/run-failures';

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
  // The exact string backends/hermes.mjs throws when the CLI binary or its
  // home is missing — the wider wording must reach the same verdict instead
  // of falling through to generic and showing raw wire text.
  expect(classifyRunFailure('Hermes executable or home is not configured')).toBe(
    'environment_unreachable',
  );
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

test('a refused environment probe classifies even as a bare state word', () => {
  // Older Gates throw the bare state word; newer ones append the probe's own
  // reason and the executable path. Both must read as an unreachable
  // environment, never as a generic error.
  expect(classifyRunFailure('environment not_installed')).toBe('environment_unreachable');
  expect(
    classifyRunFailure('environment incompatible: unsupported CLI version 0.9.1 (C:\\tools\\codex.exe)'),
  ).toBe('environment_unreachable');
  const view = describeRunFailure('environment not_installed: executable not found (C:\\bots\\hermes.exe)');
  expect(view.title).toBe('Environment unreachable');
  expect(view.next).toContain('executable path');
});

test('a busy refusal stays honest raw instead of reading as unreachable', () => {
  const busy =
    'environment is busy — task run-1 has not finished yet; cancel it from Recent runs or wait for it to complete';
  expect(classifyRunFailure(busy)).toBe('generic');
  expect(formatRunFailure(busy)).toBeNull();
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

test('routingFailureView hands the roster the same verdicts a failed send gets', () => {
  // The detail surface must not re-declare these strings — if the send-side
  // wording changes, the routing state follows in the same commit or this
  // test fails.
  expect(routingFailureView('listen_key_missing')).toEqual({
    title: 'Bot has no listen key',
    next: "Set API_SERVER_KEY in the profile's .env on the host, then retry.",
  });
  expect(routingFailureView('default_key_refused')).toEqual({
    title: 'Bot listen key refused',
    next: "Give this profile its own API_SERVER_KEY — named Bots reject the default profile's key.",
  });
});

test('a room create naming several dead bots reaches the same verdict as one', () => {
  // gate/core/cli-environments/bot-groups.mjs verifyMembers throws
  // `unknown bot${s}: ${ids}` — the PLURAL form must classify like the
  // singular send-path refusal (`\bunknown bot\b` cannot match "bots").
  const raw = 'unknown bots: ghost, phantom';
  expect(classifyRunFailure(raw)).toBe('unknown_bot');
  expect(describeRunFailure(raw).title).toBe('Bot not found');
  expect(formatRunFailure(raw)).toContain('Reload the roster');
});

test('an unreadable roster during membership checks speaks its own verdict', () => {
  // gate/core/cli-environments/bot-groups.mjs: the fronted listBots read
  // failed (error.code roster_unavailable, 502) — create/addMembers refuse.
  const raw = 'cannot verify group members: spawn failed';
  expect(classifyRunFailure(raw)).toBe('roster_unavailable');
  const view = describeRunFailure(raw);
  expect(view.title).toBe('Roster unreadable');
  expect(view.next).toMatch(/CLI environment/);
  // The prefix must never swallow a cause the classifier knows: an embedded
  // unconfigured-environment message keeps its SPECIFIC verdict.
  expect(
    classifyRunFailure('cannot verify group members: Hermes executable or home is not configured'),
  ).toBe('environment_unreachable');
});
