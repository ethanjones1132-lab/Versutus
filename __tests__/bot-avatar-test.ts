import { BOT_CREST_TONES, botCrestFromId, botInitial, registerCrestFleet } from '@/lib/bot-avatar';

/** Status hues a crest must never wear (Palette.statusConnected/Connecting/Disconnected). */
const STATUS_HUES = ['#63D7A6', '#D6B76A', '#E56D6D', '#F0D690'];

function hueDegrees(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return -1; // achromatic
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

test('the same id always derives the same crest', () => {
  expect(botCrestFromId('researcher', 'Researcher')).toEqual(botCrestFromId('researcher', 'Researcher'));
});

test('different ids spread across tones often enough to tell bots apart', () => {
  const tones = new Set(
    Array.from({ length: 40 }, (_, i) => botCrestFromId(`bot-${i}`).tone.from),
  );
  expect(tones.size).toBeGreaterThan(4);
});

test('every tone is declared and every declared tone is reachable', () => {
  const seen = new Set<string>();
  for (let h = 0; h < 4096 && seen.size < BOT_CREST_TONES.length; h += 1) {
    const { tone } = botCrestFromId(`bucket-${h}`);
    expect(BOT_CREST_TONES).toContainEqual(tone);
    seen.add(tone.from);
  }
  expect(seen.size).toBe(BOT_CREST_TONES.length);
});

test('no crest tone reuses a status hue, so identity never reads as online or failing', () => {
  // UI audit 2026-09-24 item 11: the old accent list carried the exact
  // "connected" mint, so an unroutable Bot wore a green dot.
  for (const tone of BOT_CREST_TONES) {
    for (const stop of [tone.from, tone.to]) {
      expect(STATUS_HUES).not.toContain(stop.toUpperCase());
      const hue = hueDegrees(stop);
      // Green (mint) through amber and red are status territory.
      const inStatusBand = hue >= 0 && (hue < 60 || (hue > 90 && hue < 170) || hue > 350);
      expect({ stop, inStatusBand }).toEqual({ stop, inStatusBand: false });
    }
  }
});

test('the initial is the first letter or digit of the name, upper-cased', () => {
  expect(botInitial('aria')).toBe('A');
  expect(botInitial('  forge-2')).toBe('F');
  expect(botInitial('2fa-bot')).toBe('2');
  expect(botInitial('émile')).toBe('É');
  expect(botCrestFromId('ledger-bot', 'Ledger').initial).toBe('L');
  // No name: the id speaks for the Bot.
  expect(botCrestFromId('sentinel').initial).toBe('S');
});

test('derivation is total over awkward ids (empty, astral, long)', () => {
  expect(botInitial('')).toBe('·');
  expect(botInitial('🤖')).toBe('·');
  expect(() => botCrestFromId('')).not.toThrow();
  expect(botCrestFromId('🤖-bot')).toEqual(botCrestFromId('🤖-bot'));
  expect(() => botCrestFromId('x'.repeat(500))).not.toThrow();
});

describe('fleet-aware crest tones', () => {
  afterEach(() => registerCrestFleet([]));

  test('a registered fleet never shares a tone while tones remain', () => {
    const fleet = ['aria', 'forge', 'ledger', 'sentinel', 'muse', 'scout'];
    registerCrestFleet(fleet);
    const tones = fleet.map((id) => botCrestFromId(id).tone.from);
    expect(new Set(tones).size).toBe(fleet.length);
  });

  test('a Bot whose natural tone is free keeps it inside a fleet', () => {
    const natural = botCrestFromId('aria').tone;
    registerCrestFleet(['aria']);
    expect(botCrestFromId('aria').tone).toEqual(natural);
  });

  test('assignment is independent of the order the inventory arrives in', () => {
    const fleet = ['aria', 'forge', 'ledger', 'sentinel', 'muse', 'scout'];
    registerCrestFleet(fleet);
    const forward = fleet.map((id) => botCrestFromId(id).tone);
    registerCrestFleet([...fleet].reverse());
    expect(fleet.map((id) => botCrestFromId(id).tone)).toEqual(forward);
  });

  test('ids outside the fleet fall back to their natural tone', () => {
    const natural = botCrestFromId('stranger').tone;
    registerCrestFleet(['aria', 'forge']);
    expect(botCrestFromId('stranger').tone).toEqual(natural);
  });

  test('a fleet larger than the tone set still derives a declared tone for everyone', () => {
    const fleet = Array.from({ length: BOT_CREST_TONES.length * 2 + 1 }, (_, i) => `bot-${i}`);
    registerCrestFleet(fleet);
    for (const id of fleet) expect(BOT_CREST_TONES).toContainEqual(botCrestFromId(id).tone);
  });
});
