import {
  applySessionListRead,
  EMPTY_SESSION_LIST,
  filterSessions,
  sessionCreateTitle,
  sessionListCopy,
  sessionListTitle,
  type SessionListEntry,
} from '@/lib/gateway/session-list';

const CREW: SessionListEntry = { id: 'ses_crew', title: 'Crew chat' };
const LAB: SessionListEntry = { id: 'ses_lab', title: 'Lab notes' };

test('a successful first read is believed, even when empty', () => {
  const next = applySessionListRead(EMPTY_SESSION_LIST, { ok: true, sessions: [] });
  expect(next.sessions).toEqual([]);
  expect(next.loaded).toBe(true);
  expect(next.failed).toBe(false);
  expect(sessionListCopy(next)).toBeUndefined();
});

test('a successful first read with sessions replaces the unread list', () => {
  const next = applySessionListRead(EMPTY_SESSION_LIST, { ok: true, sessions: [CREW, LAB] });
  expect(next.sessions).toEqual([CREW, LAB]);
  expect(next.loaded).toBe(true);
  expect(next.failed).toBe(false);
  expect(sessionListCopy(next)).toBeUndefined();
});

test('a failed FIRST read claims zero knowledge — not "No sessions yet"', () => {
  const next = applySessionListRead(EMPTY_SESSION_LIST, { ok: false });
  expect(next.sessions).toEqual([]);
  expect(next.loaded).toBe(false);
  expect(next.failed).toBe(true);
  expect(sessionListCopy(next)).toBe('Sessions could not be read.');
  expect(sessionListCopy(next)).not.toContain('No sessions');
});

test('a failed first read still keeps sessions that were already on screen', () => {
  // New session / Bot Chat prepend onto the unread list. A selector fetch
  // that then fails must not erase a thread the operator just opened.
  const previous = { sessions: [CREW], loaded: false, failed: false };
  const next = applySessionListRead(previous, { ok: false });
  expect(next.sessions).toEqual([CREW]);
  expect(next.loaded).toBe(false);
  expect(next.failed).toBe(true);
  expect(sessionListCopy(next)).toBe('Sessions could not be read.');
});

test('a failed RE-read keeps the last good list and names the staleness', () => {
  const loaded = applySessionListRead(EMPTY_SESSION_LIST, { ok: true, sessions: [CREW, LAB] });
  const stale = applySessionListRead(loaded, { ok: false });
  expect(stale.sessions).toEqual([CREW, LAB]);
  expect(stale.loaded).toBe(true);
  expect(stale.failed).toBe(true);
  expect(sessionListCopy(stale)).toBe('Could not re-read sessions — showing the last list.');
});

test('a failed re-read of an empty-ok list stays empty and still names the failure', () => {
  const previous = applySessionListRead(EMPTY_SESSION_LIST, { ok: true, sessions: [] });
  const next = applySessionListRead(previous, { ok: false });
  expect(next.sessions).toEqual([]);
  expect(next.loaded).toBe(true);
  expect(next.failed).toBe(true);
  expect(sessionListCopy(next)).toBe('Could not re-read sessions — showing the last list.');
});

test('a successful EMPTY read is believed — the gateway really has none now', () => {
  const previous = applySessionListRead(EMPTY_SESSION_LIST, { ok: true, sessions: [CREW] });
  const next = applySessionListRead(previous, { ok: true, sessions: [] });
  expect(next).toEqual({ sessions: [], loaded: true, failed: false });
  expect(sessionListCopy(next)).toBeUndefined();
});

test('a successful refresh replaces the list and clears the failure', () => {
  const previous = applySessionListRead(EMPTY_SESSION_LIST, { ok: true, sessions: [CREW] });
  const stale = applySessionListRead(previous, { ok: false });
  const next = applySessionListRead(stale, { ok: true, sessions: [LAB] });
  expect(next.sessions).toEqual([LAB]);
  expect(next.failed).toBe(false);
  expect(sessionListCopy(next)).toBeUndefined();
});

test('an unread list has no copy — the selector has not spoken yet', () => {
  expect(sessionListCopy(EMPTY_SESSION_LIST)).toBeUndefined();
});

test('a named new session forwards the title the operator typed', () => {
  expect(sessionCreateTitle('Crew notes')).toBe('Crew notes');
});

test('a named new session trims the title', () => {
  expect(sessionCreateTitle('  Lab notes  ')).toBe('Lab notes');
});

test('an empty name still creates untitled — today\'s behaviour', () => {
  expect(sessionCreateTitle('')).toBeUndefined();
  expect(sessionCreateTitle('   ')).toBeUndefined();
});

test('an untitled session reads as Untitled, not a truncated id', () => {
  expect(sessionListTitle(undefined)).toBe('Untitled');
  expect(sessionListTitle(null)).toBe('Untitled');
  expect(sessionListTitle('')).toBe('Untitled');
  expect(sessionListTitle('   ')).toBe('Untitled');
  expect(sessionListTitle(undefined)).not.toMatch(/^ses_/);
});

test('a named session keeps the title the operator gave it', () => {
  expect(sessionListTitle('Crew chat')).toBe('Crew chat');
  expect(sessionListTitle('  Lab notes  ')).toBe('Lab notes');
});

test('preview is a snippet, not a title stand-in', () => {
  const preview = 'the last user turn as a snippet';
  expect(sessionListTitle(undefined)).toBe('Untitled');
  expect(sessionListTitle(undefined)).not.toBe(preview);
});

const CREW_FULL = { id: 'ses_crew', title: 'Crew chat', preview: 'the last user turn' };
const LAB_FULL = { id: 'ses_lab', title: 'Lab notes', preview: 'a sketch of the experiment' };
const UNTITLED = { id: 'ses_orphan', title: undefined as string | undefined, preview: 'a stray line' };

test('filterSessions ignores a blank query — the list is unfiltered', () => {
  const sessions = [CREW_FULL, LAB_FULL];
  expect(filterSessions(sessions, '')).toBe(sessions);
  expect(filterSessions(sessions, '   ')).toBe(sessions);
});

test('filterSessions matches title, preview, and id case-insensitively', () => {
  const sessions = [CREW_FULL, LAB_FULL, UNTITLED];
  expect(filterSessions(sessions, 'CREW').map((s) => s.id)).toEqual(['ses_crew']);
  expect(filterSessions(sessions, 'experiment').map((s) => s.id)).toEqual(['ses_lab']);
  expect(filterSessions(sessions, 'SES_ORPHAN').map((s) => s.id)).toEqual(['ses_orphan']);
});

test('filterSessions finds an untitled session by the word Untitled', () => {
  const sessions = [CREW_FULL, UNTITLED];
  expect(filterSessions(sessions, 'untitled').map((s) => s.id)).toEqual(['ses_orphan']);
});

test('filterSessions with no match is empty, not the full list', () => {
  expect(filterSessions([CREW_FULL, LAB_FULL], 'nomatch')).toEqual([]);
});
