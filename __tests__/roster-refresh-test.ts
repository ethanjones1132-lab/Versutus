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
