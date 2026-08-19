import { getSlashCommandSuggestions } from '@/lib/gateway/slash-commands';
import type { SlashCommandSuggestion } from '@/lib/gateway/slash-commands';
import { filterPaletteSuggestions, groupSuggestionsByFamily } from '@/lib/gateway/slash-palette';

function suggestion(overrides: Partial<SlashCommandSuggestion> = {}): SlashCommandSuggestion {
  return {
    value: '/status',
    label: '/status',
    description: 'Show gateway status',
    danger: 'safe',
    family: 'Gateway',
    unavailable: false,
    ...overrides,
  };
}

describe('filterPaletteSuggestions', () => {
  test('returns the same reference for an empty query', () => {
    const items = [suggestion()];
    expect(filterPaletteSuggestions(items, '')).toBe(items);
    expect(filterPaletteSuggestions(items, '   ')).toBe(items);
  });

  test('matches on value, description and family', () => {
    const items = [
      suggestion({ value: '/status', description: 'Show gateway status', family: 'Gateway' }),
      suggestion({ value: '/models', description: 'List models', family: 'Catalog' }),
    ];
    expect(filterPaletteSuggestions(items, 'models')).toHaveLength(1);
    expect(filterPaletteSuggestions(items, 'List')).toHaveLength(1);
    expect(filterPaletteSuggestions(items, 'catalog')).toHaveLength(1);
  });

  test('a leading slash in the query is optional', () => {
    const items = [suggestion({ value: '/session' })];
    expect(filterPaletteSuggestions(items, '/session')).toHaveLength(1);
    expect(filterPaletteSuggestions(items, 'session')).toHaveLength(1);
    expect(filterPaletteSuggestions(items, '//session')).toHaveLength(1);
  });

  test('is case insensitive and returns nothing on no match', () => {
    const items = [suggestion({ value: '/STATUS' })];
    expect(filterPaletteSuggestions(items, 'status')).toHaveLength(1);
    expect(filterPaletteSuggestions(items, 'zzz')).toHaveLength(0);
  });
});

describe('groupSuggestionsByFamily', () => {
  test('groups rows under their family', () => {
    const groups = groupSuggestionsByFamily([
      suggestion({ value: '/a', family: 'Gateway' }),
      suggestion({ value: '/b', family: 'Catalog' }),
      suggestion({ value: '/c', family: 'Gateway' }),
    ]);
    const gateway = groups.find((group) => group.family === 'Gateway');
    expect(gateway?.items.map((item) => item.value)).toEqual(['/a', '/c']);
    expect(groups.find((group) => group.family === 'Catalog')?.items).toHaveLength(1);
  });

  test('priority families lead, the rest sort alphabetically', () => {
    const groups = groupSuggestionsByFamily([
      suggestion({ value: '/z', family: 'Zulu' }),
      suggestion({ value: '/a', family: 'Alpha' }),
      suggestion({ value: '/cap', family: 'Capability' }),
      suggestion({ value: '/chat', family: 'Chat' }),
      suggestion({ value: '/r', family: 'Recent' }),
    ]);
    expect(groups.map((group) => group.family)).toEqual([
      'Recent',
      'Chat',
      'Capability',
      'Alpha',
      'Zulu',
    ]);
  });

  test('unavailable commands sink within their group', () => {
    const groups = groupSuggestionsByFamily([
      suggestion({ value: '/dead', family: 'Gateway', unavailable: true }),
      suggestion({ value: '/live', family: 'Gateway', unavailable: false }),
    ]);
    expect(groups[0].items.map((item) => item.value)).toEqual(['/live', '/dead']);
  });

  test('a missing family falls back to Other rather than an empty heading', () => {
    const groups = groupSuggestionsByFamily([suggestion({ family: '' })]);
    expect(groups[0].family).toBe('Other');
  });
});

describe('palette consumes the full command surface', () => {
  test('the default suggestion cap does not apply when the palette asks for everything', () => {
    const capped = getSlashCommandSuggestions('', null, [], {}, []);
    const uncapped = getSlashCommandSuggestions('', null, [], {}, [], Number.POSITIVE_INFINITY);

    expect(capped.length).toBe(12);
    expect(uncapped.length).toBeGreaterThan(capped.length);
  });

  test('every uncapped row carries a family the palette can group under', () => {
    const all = getSlashCommandSuggestions('', null, [], {}, [], Number.POSITIVE_INFINITY);
    const groups = groupSuggestionsByFamily(all);

    expect(groups.length).toBeGreaterThan(1);
    expect(groups.reduce((total, group) => total + group.items.length, 0)).toBe(all.length);
    expect(groups.every((group) => group.family.length > 0)).toBe(true);
  });
});
