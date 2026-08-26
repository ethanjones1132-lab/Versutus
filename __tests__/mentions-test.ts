import {
  extractMentions,
  filterMentionMembers,
  handoffFailedNote,
  insertMention,
  mentionPicksAtCaret,
  mentionPrefix,
  mentionTokenAtCaret,
  rosterUnavailableNote,
} from '@/lib/gateway/mentions';

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

const ROOM = ['researcher', 'coder', 'default'];

test('mentionTokenAtCaret reads an empty prefix right after @', () => {
  expect(mentionTokenAtCaret('@', 1)).toEqual({ prefix: '', start: 0, end: 1 });
  expect(mentionTokenAtCaret('hey @', 5)).toEqual({ prefix: '', start: 4, end: 5 });
});

test('mentionTokenAtCaret takes the prefix up to the caret, and the token through its last character', () => {
  expect(mentionTokenAtCaret('hey @re', 7)).toEqual({ prefix: 're', start: 4, end: 7 });
  // Caret in the middle of a longer token: prefix is what has been typed
  // to the left, but a pick must replace the whole token, not splice.
  expect(mentionTokenAtCaret('@researcher', 3)).toEqual({ prefix: 're', start: 0, end: 11 });
});

test('mentionTokenAtCaret is null when the caret is not inside an @token', () => {
  expect(mentionTokenAtCaret('', 0)).toBeNull();
  expect(mentionTokenAtCaret('hey researcher', 14)).toBeNull();
  expect(mentionTokenAtCaret('@re look', 0)).toBeNull();
  expect(mentionTokenAtCaret('@re look', 8)).toBeNull();
  expect(mentionTokenAtCaret('see @re ', 8)).toBeNull();
});

test('mentionTokenAtCaret skips an email-shaped @user@host token', () => {
  // "email me @user@example.com" — @ of user is index 9, second @ is 14.
  // extractMentions also drops @user because the next char is @.
  expect(mentionTokenAtCaret('email me @user@example.com', 10)).toBeNull();
  expect(mentionTokenAtCaret('email me @user@example.com', 14)).toBeNull();
});

test('filterMentionMembers is a case-insensitive prefix of the room, in room order', () => {
  expect(filterMentionMembers('', ROOM)).toEqual(ROOM);
  expect(filterMentionMembers('re', ROOM)).toEqual(['researcher']);
  expect(filterMentionMembers('RE', ROOM)).toEqual(['researcher']);
  expect(filterMentionMembers('c', ROOM)).toEqual(['coder']);
  expect(filterMentionMembers('z', ROOM)).toEqual([]);
  // Prefix, not contains: "search" is in the middle of researcher.
  expect(filterMentionMembers('search', ROOM)).toEqual([]);
});

test('mentionPicksAtCaret offers every room member at a bare @, then narrows', () => {
  expect(mentionPicksAtCaret('@', 1, ROOM)).toEqual(ROOM);
  expect(mentionPicksAtCaret('round @co', 9, ROOM)).toEqual(['coder']);
  expect(mentionPicksAtCaret('round @Rse', 10, ROOM)).toEqual([]);
  expect(mentionPicksAtCaret('no at-sign here', 15, ROOM)).toEqual([]);
});

test('insertMention writes the canonical id so extractMentions sees a member, not a typo', () => {
  const drafted = insertMention('hey @re', 7, 'researcher');
  expect(drafted).toBe('hey @researcher ');
  expect(extractMentions(drafted, ROOM)).toEqual(['researcher']);

  // A pick replaces the whole token, even when the caret sat in the middle.
  expect(insertMention('@researcher please', 3, 'coder')).toBe('@coder please');

  // After a pick, the caret is past the token (trailing space), so the
  // next keystroke is prose, not more of the name.
  const afterPick = insertMention('@', 1, 'default');
  expect(mentionPicksAtCaret(afterPick, afterPick.length, ROOM)).toEqual([]);
});
