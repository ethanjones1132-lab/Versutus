// ─── Notification preference form tests (Solution A5/A6) ───────────────────

import {
  botFilterRows,
  formatBotIds,
  formatMinutes,
  parseBotIdsInput,
  parseQuietHoursInput,
  parseTimeToMinutes,
  toggleBotFilter,
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

describe('botFilterRows', () => {
  const bots = [
    { id: 'scout', displayName: 'Scout' },
    { id: 'herald', displayName: 'Herald' },
  ];

  test('one row per roster Bot, enabled only when the allowlist names it', () => {
    expect(botFilterRows(bots, ['scout'])).toEqual([
      { kind: 'bot', botId: 'scout', displayName: 'Scout', enabled: true },
      { kind: 'bot', botId: 'herald', displayName: 'Herald', enabled: false },
    ]);
  });

  test('an empty allowlist disables every switch — it still means every Bot', () => {
    expect(botFilterRows(bots, []).every((row) => row.kind === 'bot' && !row.enabled)).toBe(true);
  });

  test('a stored id the roster does not know stays visible as an unknown row', () => {
    expect(botFilterRows(bots, ['scout', 'typo-id'])).toEqual([
      { kind: 'bot', botId: 'scout', displayName: 'Scout', enabled: true },
      { kind: 'bot', botId: 'herald', displayName: 'Herald', enabled: false },
      { kind: 'unknown', botId: 'typo-id', enabled: true },
    ]);
  });

  test('a stored id duplicated by case-exact id does not double a roster row', () => {
    expect(botFilterRows(bots, ['scout', 'scout']).filter((row) => row.botId === 'scout')).toHaveLength(1);
  });
});

describe('toggleBotFilter', () => {
  const rows = botFilterRows(
    [
      { id: 'scout', displayName: 'Scout' },
      { id: 'herald', displayName: 'Herald' },
    ],
    ['scout'],
  );

  test('switching a Bot ON adds it to the allowlist', () => {
    expect(toggleBotFilter(rows, 'herald', true)).toEqual({ botIds: ['scout', 'herald'] });
  });

  test('switching the last allowed Bot OFF returns to every Bot', () => {
    const onlyScout = botFilterRows([{ id: 'scout', displayName: 'Scout' }], ['scout']);
    expect(toggleBotFilter(onlyScout, 'scout', false)).toEqual({ botIds: [] });
  });

  test('removing an unknown row takes its id out of the allowlist', () => {
    const withTypo = botFilterRows([], ['typo-id']);
    expect(toggleBotFilter(withTypo, 'typo-id', false)).toEqual({ botIds: [] });
  });

  test('switching an already-ON Bot ON changes nothing', () => {
    expect(toggleBotFilter(rows, 'scout', true)).toEqual({ botIds: ['scout'] });
  });
});
