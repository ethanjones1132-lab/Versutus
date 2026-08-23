import { extractMentions, handoffFailedNote, mentionPrefix, rosterUnavailableNote } from '@/lib/gateway/mentions';

test('extractMentions returns roster ids only', () => {
  const ids = ['researcher', 'coder', 'default'];
  expect(extractMentions('hey @researcher look at this @nobody @coder', ids)).toEqual([
    'researcher',
    'coder',
  ]);
  expect(extractMentions('email me @user@example.com', ids)).toEqual([]);
  expect(extractMentions('@Researcher', ids)).toEqual(['researcher']);
});

test('mentionPrefix matches Desktop handoff attribution', () => {
  expect(mentionPrefix('coder', 'look at this')).toBe('Message from 🤖 coder (@coder):\n\nlook at this');
});

test('rosterUnavailableNote says the handoff was skipped and mentions were not delivered', () => {
  const note = rosterUnavailableNote('HTTP 500');
  expect(note).toContain('Handoff skipped');
  expect(note).toContain('not delivered');
  expect(note).toContain('HTTP 500');
});

test('handoffFailedNote names the target bot and the failure', () => {
  expect(handoffFailedNote('researcher', 'connection refused')).toBe(
    'Handoff to @researcher failed: connection refused.',
  );
});

test('handoffFailedNote appends the desktop-parity fix for classifiable refusals', () => {
  const note = handoffFailedNote(
    'echo',
    'bot "echo" has no API_SERVER_KEY',
  );
  expect(note).toContain('Handoff to @echo failed:');
  expect(note).toContain('Bot has no listen key');
  expect(note).toContain("Set API_SERVER_KEY in the profile's .env on the host, then retry.");
});
