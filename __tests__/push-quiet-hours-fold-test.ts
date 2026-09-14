// ─── The quiet-hours pane's fold (Solution A4's quiet hours, the app side) ──
// The Gate enforces the window (push-notifier.mjs isQuiet) and its RPC
// validates the minutes (push-rpc.mjs validQuietHours), but nothing app-side
// let the operator read or set one until this fold: the pane's clock text is
// parsed here, the pair is validated against the Gate's own bounds, and the
// copy line is built from the minutes the Gate holds — never a second
// representation of the same fact.
//
// Every rule here is pure. An unparsable clock text is a refusal, not a guess;
// an out-of-range minute is out of range; the exemption copy is a constant so
// the pane's line and its source pin move as one.

import {
  CLOCK_MINUTES_A_DAY,
  clockTextToMinutes,
  minutesToClockText,
  QUIET_HOURS_END_LABEL,
  QUIET_HOURS_EXEMPT_COPY,
  QUIET_HOURS_START_LABEL,
  quietHoursLine,
  validQuietHoursPair,
} from '@/lib/notifications/push-quiet-hours';

describe('clockTextToMinutes', () => {
  test('parses H:MM and HH:MM into minutes since midnight', () => {
    expect(clockTextToMinutes('22:00')).toBe(22 * 60);
    expect(clockTextToMinutes('7:05')).toBe(7 * 60 + 5);
    expect(clockTextToMinutes('0:00')).toBe(0);
    expect(clockTextToMinutes(' 6:30 ')).toBe(6 * 60 + 30);
  });

  test('an unparsable line is a refusal, never a guess', () => {
    expect(clockTextToMinutes('')).toBeNull();
    expect(clockTextToMinutes('7')).toBeNull();
    expect(clockTextToMinutes('7:')).toBeNull();
    expect(clockTextToMinutes(':30')).toBeNull();
    expect(clockTextToMinutes('ab:cd')).toBeNull();
    expect(clockTextToMinutes('10:60')).toBeNull();
    expect(clockTextToMinutes('24:00')).toBeNull();
    expect(clockTextToMinutes('7:5x')).toBeNull();
  });
});

describe('validQuietHoursPair', () => {
  test('a pair inside the Gate bounds is the window, start before end or over it', () => {
    expect(validQuietHoursPair(22 * 60, 7 * 60)).toEqual({ startMinutes: 1320, endMinutes: 420 });
    expect(validQuietHoursPair(7 * 60, 22 * 60)).toEqual({ startMinutes: 420, endMinutes: 1320 });
    expect(validQuietHoursPair(1439, 0)).toEqual({ startMinutes: 1439, endMinutes: 0 });
  });

  test('an unparsed side or an out-of-range minute is no window at all', () => {
    expect(validQuietHoursPair(null, 7 * 60)).toBeNull();
    expect(validQuietHoursPair(22 * 60, null)).toBeNull();
    expect(validQuietHoursPair(24 * 60, 0)).toBeNull();
    expect(validQuietHoursPair(-1, 7 * 60)).toBeNull();
    expect(validQuietHoursPair(22 * 60, 24 * 60)).toBeNull();
  });

  test('the day bound matches the Gate validator, not a second opinion', () => {
    // push-rpc.mjs refuses startMinutes or endMinutes >= 24*60 — the same
    // bound, pinned here so the two cannot drift.
    expect(CLOCK_MINUTES_A_DAY).toBe(1440);
    expect(validQuietHoursPair(1440, 0)).toBeNull();
  });
});

describe('minutesToClockText', () => {
  test('renders minutes since midnight as H:MM with zero-padded minutes', () => {
    expect(minutesToClockText(1320)).toBe('22:00');
    expect(minutesToClockText(0)).toBe('0:00');
    expect(minutesToClockText(425)).toBe('7:05');
    expect(minutesToClockText(1439)).toBe('23:59');
  });
});

describe('quietHoursLine', () => {
  test('a held window reads as its own clock text, both ways round', () => {
    expect(quietHoursLine({ startMinutes: 1320, endMinutes: 420 })).toBe(
      'Quiet from 22:00 to 7:00.',
    );
  });

  test('an absent window says so instead of inventing hours', () => {
    expect(quietHoursLine(null)).toBe('No quiet hours. Push arrives around the clock.');
  });
});

describe('the pane copy constants', () => {
  test('the exemption sentence names approvals only', () => {
    expect(QUIET_HOURS_EXEMPT_COPY).toBe(
      "A quiet window can't excuse an approval push — those break through.",
    );
    expect(QUIET_HOURS_START_LABEL).toBe('Quiet from (24h H:MM)');
    expect(QUIET_HOURS_END_LABEL).toBe('Quiet until (24h H:MM)');
  });
});
