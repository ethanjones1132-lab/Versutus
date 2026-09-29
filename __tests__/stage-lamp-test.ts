import { BOT_CREST_TONES, botCrestFromId, registerCrestFleet } from '@/lib/bot-avatar';
import {
  BRAND_TONE,
  LAMP_CORE_CHROMA,
  LAMP_CORE_FLOOR,
  LAMP_EDGE_CHROMA,
  LAMP_EDGE_FLOOR,
  STAGE_BASE_HEX,
  STAGE_CEILING,
  STAGE_LIGHT_BUDGET,
  STAGE_TEXT_FLOOR_HEX,
  STATUS_HUES_OKLCH,
  STATUS_HUE_CLEARANCE,
  contrastRatio,
  guardLampHue,
  hexToLinear,
  lampLight,
  linearToOklch,
  luminance,
  mixLights,
  stageCeilingContrast,
  stageLightsFor,
  stageRoomKey,
  type Rgb,
} from '@/lib/stage/lamp';

declare const __dirname: string;

afterEach(() => registerCrestFleet([]));

/** A palette hex, read from tokens.ts itself (importing it would pull in reanimated). */
function paletteHex(key: string): string {
  const fs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
  const sep = __dirname.includes('\\') ? '\\' : '/';
  const source = fs.readFileSync([__dirname, '..', 'src', 'constants', 'tokens.ts'].join(sep), 'utf8');
  const match = new RegExp(`\\n\\s*${key}: '(#[0-9A-Fa-f]{6})'`).exec(source);
  if (!match) throw new Error(`Palette.${key} not found`);
  return match[1];
}

/** Every lamp colour any room can produce: each crest tone's core and fringe. */
const LAMPS: { name: string; color: Rgb; crest: string }[] = BOT_CREST_TONES.flatMap((tone) => [
  { name: `${tone.from} core`, color: lampLight(tone.from, LAMP_CORE_CHROMA, LAMP_CORE_FLOOR), crest: tone.from },
  { name: `${tone.to} edge`, color: lampLight(tone.to, LAMP_EDGE_CHROMA, LAMP_EDGE_FLOOR), crest: tone.to },
]);

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

describe('the stage the lamp lights', () => {
  test('is the palette’s own stage and its dimmest stage text', () => {
    expect(STAGE_BASE_HEX).toBe(paletteHex('background'));
    expect(STAGE_TEXT_FLOOR_HEX).toBe(paletteHex('textTertiary'));
  });

  test('its ceiling is exactly where tertiary text falls to 4.5:1', () => {
    expect(contrastRatio(luminance(hexToLinear(STAGE_TEXT_FLOOR_HEX)), STAGE_CEILING)).toBeCloseTo(4.5, 6);
    expect(STAGE_LIGHT_BUDGET).toBeGreaterThan(0);
    expect(STAGE_LIGHT_BUDGET).toBeLessThan(STAGE_CEILING - luminance(hexToLinear(STAGE_BASE_HEX)));
  });
});

describe('lamp colours', () => {
  test.each(LAMPS)('$name carries exactly the light budget, with no negative channel', ({ color }) => {
    expect(luminance(color)).toBeCloseTo(STAGE_LIGHT_BUDGET, 6);
    for (const channel of color) expect(channel).toBeGreaterThanOrEqual(0);
  });

  test.each(LAMPS)('$name keeps the dimmest stage text at AA under its brightest pixel, dither included', ({ color }) => {
    expect(stageCeilingContrast(color, 1)).toBeGreaterThanOrEqual(4.5);
  });

  test.each(LAMPS.filter(({ color }) => linearToOklch(color).c > 0.02))(
    '$name keeps clear of every status hue, so no room reads as a state',
    ({ color }) => {
      const { h } = linearToOklch(color);
      for (const status of STATUS_HUES_OKLCH) {
        expect(hueDistance(h, status)).toBeGreaterThanOrEqual(STATUS_HUE_CLEARANCE - 0.5);
      }
    },
  );

  test('a grey crest stays moonlight; every coloured crest is lit as its colour', () => {
    for (const { crest, color } of LAMPS) {
      const crestIsGrey = linearToOklch(hexToLinear(crest)).c < 0.04;
      const chroma = linearToOklch(color).c;
      if (crestIsGrey) expect(chroma).toBeLessThan(0.03);
      // Cyan runs out of sRGB gamut first at this brightness (≈0.042).
      else expect(chroma).toBeGreaterThan(0.04);
    }
  });

  test('a hue inside a status band is steered to the band’s nearest edge', () => {
    const [red, amber, mint] = STATUS_HUES_OKLCH;
    expect(guardLampHue(red + 2)).toBeCloseTo(red + STATUS_HUE_CLEARANCE, 6);
    expect(guardLampHue(red - 2)).toBeCloseTo(red - STATUS_HUE_CLEARANCE + 360, 6);
    expect(guardLampHue(amber)).toBeCloseTo(amber - STATUS_HUE_CLEARANCE, 6);
    expect(guardLampHue(mint + 10)).toBeCloseTo(mint + STATUS_HUE_CLEARANCE, 6);
    // Violet is nowhere near a status hue and passes untouched.
    expect(guardLampHue(285)).toBe(285);
  });
});

describe('rooms', () => {
  test('each room has one stable key, and an absent room is the lobby', () => {
    expect(stageRoomKey(undefined)).toBe('lobby');
    expect(stageRoomKey({ kind: 'lobby' })).toBe('lobby');
    expect(stageRoomKey({ kind: 'direct' })).toBe('direct');
    expect(stageRoomKey({ kind: 'bot', botId: 'forge', name: 'Forge' })).toBe('bot:forge');
    expect(stageRoomKey({ kind: 'room', memberIds: ['a', 'b', 'c', 'd'] })).toBe('room:a,b,c');
  });

  test('the lobby and a direct chat are lit in the house violet', () => {
    const house = stageLightsFor({ kind: 'lobby' });
    expect(stageLightsFor({ kind: 'direct' })).toEqual(house);
    expect(stageLightsFor(undefined)).toEqual(house);
    expect(house.key.core).toEqual(lampLight(BRAND_TONE.from, LAMP_CORE_CHROMA, LAMP_CORE_FLOOR));
    expect(house.guestA.gain).toBe(0);
    expect(house.guestB.gain).toBe(0);
  });

  test('a Bot’s thread is lit in that Bot’s crest tone — the fleet-assigned one', () => {
    registerCrestFleet(['aria', 'forge', 'ledger', 'sentinel', 'muse', 'scout']);
    for (const id of ['aria', 'forge', 'scout']) {
      const tone = botCrestFromId(id).tone;
      const { key } = stageLightsFor({ kind: 'bot', botId: id });
      expect(key.edge).toEqual(lampLight(tone.to, LAMP_EDGE_CHROMA, LAMP_EDGE_FLOOR));
      expect(key.gain).toBe(1);
    }
    // Two Bots never share a room light while tones remain.
    const keys = ['aria', 'forge', 'ledger', 'sentinel', 'muse', 'scout'].map((id) =>
      JSON.stringify(stageLightsFor({ kind: 'bot', botId: id }).key.edge),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('a group room hangs one lamp per member, up to three, each in its own seat', () => {
    const three = stageLightsFor({ kind: 'room', memberIds: ['aria', 'forge', 'ledger', 'muse'] });
    expect([three.key.gain, three.guestA.gain > 0, three.guestB.gain > 0]).toEqual([1, true, true]);
    expect(new Set([three.key.x, three.guestA.x, three.guestB.x]).size).toBe(3);
    const two = stageLightsFor({ kind: 'room', memberIds: ['aria', 'forge'] });
    expect(two.guestA.gain).toBeGreaterThan(0);
    expect(two.guestB.gain).toBe(0);
    expect(stageLightsFor({ kind: 'room', memberIds: [] })).toEqual(stageLightsFor({ kind: 'lobby' }));
  });

  test('a room change mixes every part of the light, end to end', () => {
    const a = stageLightsFor({ kind: 'lobby' });
    const b = stageLightsFor({ kind: 'room', memberIds: ['aria', 'forge', 'ledger'] });
    expect(mixLights(a, b, 0)).toEqual(a);
    expect(mixLights(a, b, 1)).toEqual(b);
    const mid = mixLights(a, b, 0.5);
    expect(mid.key.x).toBeCloseTo((a.key.x + b.key.x) / 2, 9);
    expect(mid.guestA.gain).toBeCloseTo((a.guestA.gain + b.guestA.gain) / 2, 9);
  });
});
