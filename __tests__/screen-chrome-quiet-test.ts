// tokens.ts only needs Easing for Motion curves; reanimated's native
// worklet unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));

declare const __dirname: string;

import { Palette } from '@/constants/tokens';

/**
 * Contract test for the quiet shared-chrome pass (CHARTER priority 1,
 * visual-direction-2026-09): ScreenHeader's trailing control rests on a flat
 * inset panel wearing brand violet (not a lit chip + focus tint), StatTile's
 * icon is demoted to the cool secondary gray so the headline carries the
 * tile, and the ambient field every Screen mounts paints violet orbs on cool
 * hairlines — never champagne GOLD/SAPPHIRE glass. Public APIs unchanged.
 */

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};
const SEP = __dirname.includes('\\') ? '\\' : '/';

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function hex(value: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(value);
  if (!m) throw new Error(`expected 6-digit hex, got ${value}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

describe('ScreenHeader rests on quiet inset chrome', () => {
  const src = readSource('src', 'components', 'ui', 'ScreenHeader.tsx');

  it('the trailing control is a flat inset panel, not a lit chip pill', () => {
    expect(src).toContain('variant="inset"');
    expect(src).not.toContain('variant="chip"');
  });

  it('the trailing glyph wears brand violet at rest, not the focus tint', () => {
    expect(src).toContain('color={tokens.accent}');
    expect(src).toContain('tintColor={tokens.accent}');
    expect(src).not.toContain('tokens.accentWarm');
    expect(src).not.toMatch(/tokens\.glass\b|tokens\.glassBorder/);
  });

  it('keeps the title/subtitle/trailing entry API', () => {
    for (const needle of ['title', 'subtitle', 'onTrailingPress', 'trailingIcon', 'trailing']) {
      expect(src).toContain(needle);
    }
  });
});

describe('StatTile icon is demoted so the headline carries the tile', () => {
  const src = readSource('src', 'components', 'ui', 'StatTile.tsx');

  it('the icon rests on the cool secondary gray, never a brand-lit tint', () => {
    expect(src).toContain('color="textSecondary"');
    expect(src).not.toContain('accentWarm');
    expect(src).not.toContain('Palette.gold');
  });

  it('keeps the inset tile and headline/label/sub API', () => {
    expect(src).toContain('variant="inset"');
    expect(src).toContain('variant="headline"');
    expect(src).toContain('label: string');
    expect(src).toContain('value: string');
    expect(src).toContain('sub?: string');
    expect(src).toContain('icon?: IconName');
  });

  it('the cool secondary gray is a palette key, not a warm literal', () => {
    const [r, g, b] = hex(Palette.textSecondary);
    expect(b).toBeGreaterThanOrEqual(r);
    expect(b).toBeGreaterThanOrEqual(g);
    expect(Palette.textSecondary).not.toBe(Palette.gold);
  });
});

describe('the ambient stage every Screen mounts paints violet, not champagne glass', () => {
  const native = readSource('src', 'components', 'layout', 'AmbientCanvas.native.tsx');
  const fallback = readSource('src', 'components', 'layout', 'ambient-fallback.tsx');
  const AMBIENT_FILES: [string, string][] = [
    ['native Skia canvas', native],
    ['reanimated fallback', fallback],
  ];

  it.each(AMBIENT_FILES)('%s drops glass tiers and champagne/sapphire leftovers', (_label, src) => {
    expect(src).not.toContain('glassBorder');
    expect(src).not.toContain('GOLD');
    expect(src).not.toContain('SAPPHIRE');
    expect(src).not.toContain('goldRule');
    expect(src).not.toMatch(/rgba\(\s*240\s*,\s*214\s*,\s*144/);
    expect(src).not.toMatch(/rgba\(\s*59\s*,\s*111\s*,\s*217/);
    expect(src).not.toMatch(/Palette\.glass\b|Palette\.gold\b/);
  });

  it('the native orbs are violet-dominant at subliminal alpha', () => {
    const orbs = [...native.matchAll(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/g)];
    expect(orbs.length).toBeGreaterThanOrEqual(2);
    for (const match of orbs) {
      const r = Number(match[1]);
      const g = Number(match[2]);
      const b = Number(match[3]);
      const a = Number(match[4]);
      expect(b).toBeGreaterThanOrEqual(r);
      expect(r).toBeGreaterThan(g);
      expect(a).toBeLessThanOrEqual(0.2);
    }
    expect(native).toContain('VIOLET');
    expect(native).toContain('VIOLET_BRIGHT');
  });

  it('plates and the center line sit on cool hairlines with muted violet rules', () => {
    for (const [, src] of AMBIENT_FILES) {
      expect(src).toContain('borderColor: tokens.border');
      expect(src).toContain('backgroundColor: tokens.border');
      expect(src).toContain('styles.rule, styles.ruleTop');
      expect(src).toContain('tokens.accentMuted');
      expect(src).toContain('tokens.accentWarmMuted');
      expect(src).not.toContain('styles.goldRule');
    }
    expect(fallback).toContain('color={tokens.accentWarmMuted}');
    expect(fallback).toContain('color={tokens.accentMuted}');
  });

  it('the Screen shell keeps its cool stage and ambient API', () => {
    const screen = readSource('src', 'components', 'ui', 'Screen.tsx');
    expect(screen).toContain('backgroundColor: tokens.background');
    expect(screen).toContain('ambient = true');
    expect(screen).toContain('AmbientCanvas');
  });
});

describe('brand accent stays soft electric violet, gold stays a rare highlight', () => {
  it('accent is violet-dominant and never the gold highlight token', () => {
    const [r, g, b] = hex(Palette.accent);
    expect(b).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(g);
    expect(Palette.accent).not.toBe(Palette.gold);
    expect(Palette.gold).toBeTruthy();
  });
});
