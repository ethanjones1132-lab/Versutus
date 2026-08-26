import {
  applyGroupRead,
  EMPTY_GROUPS,
  groupsListCopy,
  resolveOpenGroup,
  type BotGroupRoom,
} from '@/lib/gateway/groups';
import { applyRosterRead, type PublicBot, type RosterRow } from '@/lib/gateway/roster-read';

const NAVIGATION_ROW: RosterRow = { kind: 'configurable' };

function botRow(id: string): RosterRow {
  return { kind: 'bot', bot: { id, displayName: id, routable: true } };
}

function botsOf(rows: RosterRow[]): string[] {
  return rows.flatMap((row) => (row.kind === 'bot' ? [row.bot.id] : []));
}

test('a good read becomes the roster, navigation row first', () => {
  const read = {
    ok: true as const,
    bots: [
      { id: 'default', displayName: 'Harumesu', routable: true },
      { id: 'scout', displayName: 'scout', routable: false },
    ] satisfies PublicBot[],
  };
  const rows = applyRosterRead([NAVIGATION_ROW], read);
  expect(rows[0]).toEqual({ kind: 'configurable' });
  expect(botsOf(rows)).toEqual(['default', 'scout']);
});

test('a failed FIRST read claims zero knowledge — navigation row only', () => {
  const rows = applyRosterRead([NAVIGATION_ROW], { ok: false });
  expect(rows).toEqual([{ kind: 'configurable' }]);
});

test('a failed RE-read keeps the last good inventory — a network blip erases nothing', () => {
  const previous = [NAVIGATION_ROW, botRow('scout'), botRow('default')];
  const rows = applyRosterRead(previous, { ok: false });
  expect(rows).toBe(previous);
  expect(botsOf(rows)).toEqual(['scout', 'default']);
});

test('a failed re-read after a never-loaded roster still claims zero knowledge', () => {
  // A previous read that FAILED left only the navigation row; that is not a
  // last-good inventory and must not masquerade as one.
  const rows = applyRosterRead([NAVIGATION_ROW], { ok: false });
  expect(rows).toEqual([{ kind: 'configurable' }]);
});

test('a successful refresh replaces stale inventory — new bot in, removed bot out', () => {
  const previous = [NAVIGATION_ROW, botRow('retired'), botRow('scout')];
  const read = { ok: true as const, bots: [{ id: 'scout', displayName: 'scout', routable: true }, { id: 'fresh', displayName: 'fresh', routable: true }] };
  const rows = applyRosterRead(previous, read);
  expect(botsOf(rows)).toEqual(['scout', 'fresh']);
});

test('a successful EMPTY read is believed — the host really has no bots now', () => {
  // The mirror of the failed-read rule: only a good answer may clear the
  // list, and this one is good. Wiping here is truth, not data loss.
  const previous = [NAVIGATION_ROW, botRow('scout')];
  const rows = applyRosterRead(previous, { ok: true, bots: [] });
  expect(rows).toEqual([{ kind: 'configurable' }]);
});

const CREW: BotGroupRoom = { id: 'room1', name: 'crew', memberIds: ['coder', 'researcher'] };
const LAB: BotGroupRoom = { id: 'room2', name: 'lab', memberIds: ['scout', 'writer'] };

test('a good room read becomes the roster copy', () => {
  const next = applyGroupRead(EMPTY_GROUPS, { ok: true, rooms: [CREW, LAB] });
  expect(next.rooms).toEqual([CREW, LAB]);
  expect(next.loaded).toBe(true);
  expect(next.failed).toBe(false);
  expect(groupsListCopy(next)).toBeUndefined();
});

test('a failed FIRST room read claims zero knowledge — no invented rooms', () => {
  const next = applyGroupRead(EMPTY_GROUPS, { ok: false });
  expect(next.rooms).toEqual([]);
  expect(next.loaded).toBe(false);
  expect(next.failed).toBe(true);
  expect(groupsListCopy(next)).toBe('Rooms could not be read.');
});

test('a failed RE-read keeps the last good rooms — a network blip erases nothing', () => {
  const previous = applyGroupRead(EMPTY_GROUPS, { ok: true, rooms: [CREW, LAB] });
  const next = applyGroupRead(previous, { ok: false });
  expect(next.rooms).toBe(previous.rooms);
  expect(next.rooms).toEqual([CREW, LAB]);
  expect(next.loaded).toBe(true);
  expect(next.failed).toBe(true);
  expect(groupsListCopy(next)).toBe('Could not re-read rooms — showing the last list.');
});

test('a failed re-read after a never-loaded room list still claims zero knowledge', () => {
  const previous = applyGroupRead(EMPTY_GROUPS, { ok: false });
  const next = applyGroupRead(previous, { ok: false });
  expect(next.rooms).toEqual([]);
  expect(next.loaded).toBe(false);
  expect(groupsListCopy(next)).toBe('Rooms could not be read.');
});

test('a successful room refresh replaces stale rooms — new room in, removed room out', () => {
  const previous = applyGroupRead(EMPTY_GROUPS, { ok: true, rooms: [CREW] });
  const next = applyGroupRead(previous, { ok: true, rooms: [LAB] });
  expect(next.rooms).toEqual([LAB]);
  expect(next.failed).toBe(false);
});

test('a successful EMPTY room read is believed — the host really has no rooms now', () => {
  const previous = applyGroupRead(EMPTY_GROUPS, { ok: true, rooms: [CREW] });
  const next = applyGroupRead(previous, { ok: true, rooms: [] });
  expect(next.rooms).toEqual([]);
  expect(next.loaded).toBe(true);
  expect(next.failed).toBe(false);
  expect(groupsListCopy(next)).toBeUndefined();
});

test('the open room is still that room after a failed re-read', () => {
  const previous = applyGroupRead(EMPTY_GROUPS, { ok: true, rooms: [CREW] });
  const stale = applyGroupRead(previous, { ok: false });
  expect(resolveOpenGroup('room1', stale)).toEqual({ kind: 'open', room: CREW });
});

test('a missing room after a successful read is gone', () => {
  const next = applyGroupRead(EMPTY_GROUPS, { ok: true, rooms: [LAB] });
  expect(resolveOpenGroup('room1', next)).toEqual({ kind: 'gone' });
});

test('a missing room before any successful read is unread, not gone', () => {
  const next = applyGroupRead(EMPTY_GROUPS, { ok: false });
  expect(resolveOpenGroup('room1', next)).toEqual({ kind: 'unread' });
});
