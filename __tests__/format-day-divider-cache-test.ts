import { formatDayDividerCached } from '@/lib/format';

describe('formatDayDividerCached', () => {
  // Fixed "now" on 2026-08-29; messages on the same day and the day before it.
  const now = new Date(2026, 7, 29, 11, 0, 0).getTime();
  const morning = new Date(2026, 7, 29, 9, 15, 0).getTime();
  const evening = new Date(2026, 7, 29, 18, 42, 0).getTime();
  const yesterday = new Date(2026, 7, 28, 18, 0, 0).getTime();

  test('returns the same string for repeated calls on the same day', () => {
    const first = formatDayDividerCached(morning, now);
    const second = formatDayDividerCached(morning, now);
    expect(second).toBe('Today');
    // Same identity means the work was not recomputed.
    expect(second).toBe(first);
  });

  test('a second timestamp within the same day does not recompute the first', () => {
    const morningLabel = formatDayDividerCached(morning, now);
    const eveningLabel = formatDayDividerCached(evening, now);
    // Both are "Today" and hit the shared per-day cache entry.
    expect(morningLabel).toBe('Today');
    expect(eveningLabel).toBe('Today');
    // A fresh call for the morning reuses the cached label (no new Date work).
    expect(formatDayDividerCached(morning, now)).toBe(morningLabel);
  });

  test('a label for a different day is computed and cached separately', () => {
    const today = formatDayDividerCached(morning, now);
    const prev = formatDayDividerCached(yesterday, now);
    expect(today).toBe('Today');
    expect(prev).toBe('Yesterday');
    // Both day keys keep their own entry.
    expect(formatDayDividerCached(morning, now)).toBe(today);
    expect(formatDayDividerCached(yesterday, now)).toBe(prev);
  });

  test('a day rollover invalidates the cache for the current day', () => {
    const before = formatDayDividerCached(morning, now);
    expect(before).toBe('Today');
    // A new "now" one day later makes the 29th a "Yesterday" and the 28th a weekday.
    const rolledNow = new Date(2026, 7, 30, 11, 0, 0).getTime();
    expect(formatDayDividerCached(morning, rolledNow)).toBe('Yesterday');
    expect(formatDayDividerCached(yesterday, rolledNow)).toBe('Friday');
  });
});
