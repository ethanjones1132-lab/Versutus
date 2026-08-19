import {
  USAGE_ENTRY_CAP,
  USAGE_HALF_LIFE_MS,
  parseStoredUsage,
  rankCommands,
  recordUsage,
  scoreUsage,
  type CommandUsage,
} from '@/lib/gateway/command-frequency';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function usage(command: string, count: number, agoMs = 0): CommandUsage {
  return { command, count, lastUsedAt: NOW - agoMs };
}

describe('scoreUsage', () => {
  test('a use just now is worth its full count', () => {
    expect(scoreUsage(usage('/a', 4), NOW)).toBeCloseTo(4, 6);
  });

  test('one half-life halves the score', () => {
    expect(scoreUsage(usage('/a', 4, USAGE_HALF_LIFE_MS), NOW)).toBeCloseTo(2, 6);
  });

  test('two half-lives quarter it', () => {
    expect(scoreUsage(usage('/a', 4, USAGE_HALF_LIFE_MS * 2), NOW)).toBeCloseTo(1, 6);
  });

  test('a future timestamp is clamped rather than scoring above its count', () => {
    expect(scoreUsage({ command: '/a', count: 3, lastUsedAt: NOW + DAY }, NOW)).toBeCloseTo(3, 6);
  });
});

describe('recordUsage', () => {
  test('a new command starts at one use', () => {
    const next = recordUsage([], '/status', NOW);
    expect(next).toEqual([{ command: '/status', count: 1, lastUsedAt: NOW }]);
  });

  test('an existing command increments and refreshes its timestamp', () => {
    const next = recordUsage([usage('/status', 2, DAY)], '/status', NOW);
    expect(next).toEqual([{ command: '/status', count: 3, lastUsedAt: NOW }]);
  });

  test('does not mutate the list it was given', () => {
    const before = [usage('/status', 2)];
    const snapshot = JSON.parse(JSON.stringify(before));
    recordUsage(before, '/status', NOW);
    expect(before).toEqual(snapshot);
  });

  test('trims whitespace and ignores an empty command', () => {
    expect(recordUsage([], '  /status  ', NOW)[0].command).toBe('/status');
    expect(recordUsage([], '   ', NOW)).toEqual([]);
  });

  test('evicts the lowest-scoring entry, not the oldest, at the cap', () => {
    // A daily driver that has not been run for a day...
    const daily = usage('/daily', 50, DAY);
    // ...plus a full cap of one-off commands used seconds ago.
    const oneOffs = Array.from({ length: USAGE_ENTRY_CAP }, (_, i) => usage(`/one-off-${i}`, 1, i * 1000));

    const next = recordUsage([daily, ...oneOffs], '/brand-new', NOW);

    expect(next).toHaveLength(USAGE_ENTRY_CAP);
    expect(next.some((entry) => entry.command === '/daily')).toBe(true);
  });
});

describe('rankCommands', () => {
  test('more-used commands rank ahead of less-used ones', () => {
    const ranked = rankCommands([usage('/rare', 1), usage('/common', 9)], NOW);
    expect(ranked).toEqual(['/common', '/rare']);
  });

  test('recency can overturn a raw count advantage once it decays', () => {
    // 8 uses a month ago decays below 3 uses today.
    const stale = usage('/stale', 8, USAGE_HALF_LIFE_MS * 4);
    const fresh = usage('/fresh', 3);
    expect(rankCommands([stale, fresh], NOW)[0]).toBe('/fresh');
  });

  test('equal scores break on recency', () => {
    const older = usage('/older', 2, DAY * 2);
    const newer = usage('/newer', 2, DAY * 2);
    newer.lastUsedAt = NOW - DAY;
    expect(rankCommands([older, newer], NOW)[0]).toBe('/newer');
  });

  test('fully tied entries order stably by command text', () => {
    const a = usage('/bbb', 1);
    const b = usage('/aaa', 1);
    expect(rankCommands([a, b], NOW)).toEqual(['/aaa', '/bbb']);
    expect(rankCommands([b, a], NOW)).toEqual(['/aaa', '/bbb']);
  });

  test('respects a limit', () => {
    const entries = [usage('/a', 5), usage('/b', 4), usage('/c', 3)];
    expect(rankCommands(entries, NOW, 2)).toEqual(['/a', '/b']);
  });

  test('an empty list ranks to nothing', () => {
    expect(rankCommands([], NOW)).toEqual([]);
  });
});

describe('parseStoredUsage', () => {
  test('migrates the legacy string[] MRU preserving its order', () => {
    const parsed = parseStoredUsage(['/first', '/second', '/third'], NOW);

    expect(parsed.map((entry) => entry.command)).toEqual(['/first', '/second', '/third']);
    expect(parsed.every((entry) => entry.count === 1)).toBe(true);
    // Ranking the migrated list must reproduce the old order rather than
    // scrambling what the user had built up.
    expect(rankCommands(parsed, NOW)).toEqual(['/first', '/second', '/third']);
  });

  test('reads the current object shape', () => {
    const parsed = parseStoredUsage([{ command: '/a', count: 4, lastUsedAt: 123 }], NOW);
    expect(parsed).toEqual([{ command: '/a', count: 4, lastUsedAt: 123 }]);
  });

  test('drops malformed entries instead of throwing', () => {
    const parsed = parseStoredUsage([{ command: '/ok', count: 2, lastUsedAt: 1 }, null, 42, {}, { command: '' }], NOW);
    expect(parsed).toEqual([{ command: '/ok', count: 2, lastUsedAt: 1 }]);
  });

  test('defaults a missing count and timestamp rather than dropping the row', () => {
    const parsed = parseStoredUsage([{ command: '/a' }], NOW);
    expect(parsed).toEqual([{ command: '/a', count: 1, lastUsedAt: NOW }]);
  });

  test('non-array input yields nothing', () => {
    expect(parseStoredUsage(null, NOW)).toEqual([]);
    expect(parseStoredUsage({ nope: true }, NOW)).toEqual([]);
    expect(parseStoredUsage('string', NOW)).toEqual([]);
  });
});
