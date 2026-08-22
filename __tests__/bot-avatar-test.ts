import {
  BOT_AVATAR_ACCENTS,
  BOT_AVATAR_SHAPES,
  botAvatarFromId,
} from '@/lib/bot-avatar';

test('the same id always derives the same avatar', () => {
  const first = botAvatarFromId('researcher');
  const second = botAvatarFromId('researcher');
  expect(second).toEqual(first);
});

test('different ids derive different avatars often enough to tell bots apart', () => {
  const avatars = Array.from({ length: 30 }, (_, i) => botAvatarFromId(`bot-${i}`));
  const shapes = new Set(avatars.map((a) => a.shape));
  const accents = new Set(avatars.map((a) => a.accent));
  // A roster of a handful of bots must not collapse onto one look.
  expect(shapes.size).toBeGreaterThan(1);
  expect(accents.size).toBeGreaterThan(2);
});

test('every derived avatar is one of the declared combinations', () => {
  for (const id of ['default', 'researcher', '', '🤖-bot', 'x'.repeat(500)]) {
    const avatar = botAvatarFromId(id);
    expect(BOT_AVATAR_SHAPES).toContain(avatar.shape);
    expect(BOT_AVATAR_ACCENTS).toContain(avatar.accent);
  }
});

test('derivation is total over awkward ids (empty, astral, long)', () => {
  expect(() => botAvatarFromId('')).not.toThrow();
  expect(() => botAvatarFromId('🤖-bot')).not.toThrow();
  // Astral characters are surrogate pairs; the hash walks code units, so both
  // halves participate and the result stays stable.
  expect(botAvatarFromId('🤖-bot')).toEqual(botAvatarFromId('🤖-bot'));
});

test('the combination space is exactly shapes x accents with no dead buckets', () => {
  expect(BOT_AVATAR_SHAPES.length * BOT_AVATAR_ACCENTS.length).toBe(15);
  const seen = new Set<string>();
  for (let h = 0; h < 4096; h += 1) {
    // Reconstruct bucket coverage by hashing synthetic ids until every
    // shape/accent pair appears at least once.
    seen.add(Object.values(botAvatarFromId(`bucket-${h}`)).join(':'));
    if (seen.size === 15) break;
  }
  expect(seen.size).toBe(15);
});
