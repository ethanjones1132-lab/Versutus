import {
  applySessionListRead,
  EMPTY_SESSION_LIST,
  sessionListCopy,
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
