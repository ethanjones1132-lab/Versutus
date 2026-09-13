// ─── Notification preference form tests (Solution A5/A6) ───────────────────

import {
  formatBotIds,
  formatMinutes,
  parseBotIdsInput,
  parseQuietHoursInput,
  parseTimeToMinutes,
} from '@/lib/notifications/preference-forms';

describe('parseTimeToMinutes', () => {
  test('reads HH:MM around the clock', () => {
    expect(parseTimeToMinutes('22:00')).toBe(1320);
    expect(parseTimeToMinutes('07:05')).toBe(425);
    expect(parseTimeToMinutes('00:00')).toBe(0);
    expect(parseTimeToMinutes('23:59')).toBe(1439);
  });

  test('rejects non-times', () => {
    expect(parseTimeToMinutes('')).toBeNull();
    expect(parseTimeToMinutes('10pm')).toBeNull();
    expect(parseTimeToMinutes('24:00')).toBeNull();
    expect(parseTimeToMinutes('12:60')).toBeNull();
    expect(parseTimeToMinutes('9')).toBeNull();
  });
});

describe('formatMinutes', () => {
  test('round-trips through the parser', () => {
    expect(parseTimeToMinutes(formatMinutes(1320))).toBe(1320);
    expect(formatMinutes(425)).toBe('07:05');
    expect(formatMinutes(0)).toBe('00:00');
  });
});

describe('parseQuietHoursInput', () => {
  test('two times become a window', () => {
    expect(parseQuietHoursInput('22:00', '07:00')).toEqual({
      quietHours: { startMinutes: 1320, endMinutes: 420 },
    });
  });

  test('two empty fields clear the window', () => {
    expect(parseQuietHoursInput('', '  ')).toEqual({ quietHours: null });
  });

  test('half a window is an error, never a guess', () => {
    expect(parseQuietHoursInput('22:00', '')).toEqual({
      error: expect.stringContaining('HH:MM'),
    });
    expect(parseQuietHoursInput('late', '07:00')).toEqual({
      error: expect.stringContaining('late'),
    });
  });
});

describe('bot allowlist', () => {
  test('comma-separated ids dedupe and trim; empty means every Bot', () => {
    expect(parseBotIdsInput('scout, herald, scout')).toEqual(['scout', 'herald']);
    expect(parseBotIdsInput('   ')).toEqual([]);
  });

  test('format joins for the text field', () => {
    expect(formatBotIds(['scout', 'herald'])).toBe('scout, herald');
    expect(formatBotIds([])).toBe('');
  });
});
