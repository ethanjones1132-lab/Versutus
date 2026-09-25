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
 * tile, and the ambient field every Screen mounts is a flat stage with at most one
 * faint still violet glow — never champagne GOLD/SAPPHIRE glass or busy art.
 * Public APIs unchanged.
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

describe('the ambient stage every Screen mounts is flat, violet, and still', () => {
  const native = readSource('src', 'components', 'layout', 'AmbientCanvas.native.tsx');
  const fallback = readSource('src', 'components', 'layout', 'ambient-fallback.tsx');
  const AMBIENT_FILES: [string, string][] = [
    ['native Skia canvas', native],
    ['still-glow fallback', fallback],
  ];

  it.each(AMBIENT_FILES)('%s is quiet — no grain, tilt, stray rules, or drift loops', (_label, src) => {
    expect(src).not.toContain('glassBorder');
    expect(src).not.toContain('GOLD');
    expect(src).not.toContain('SAPPHIRE');
    expect(src).not.toContain('goldRule');
    expect(src).not.toContain('grain.png');
    expect(src).not.toContain('ImageShader');
    expect(src).not.toContain('withRepeat');
    expect(src).not.toContain('withTiming');
    expect(src).not.toMatch(/rotate:\s*'?-?\d/);
    expect(src).not.toContain('styles.plate');
    expect(src).not.toContain('styles.rule');
    expect(src).not.toContain('centerLine');
    expect(src).not.toContain('styles.vignette');
    expect(src).not.toMatch(/rgba\(\s*240\s*,\s*214\s*,\s*144/);
    expect(src).not.toMatch(/rgba\(\s*59\s*,\s*111\s*,\s*217/);
    expect(src).not.toMatch(/Palette\.glass\b|Palette\.gold\b/);
  });

  it('mounts exactly one faint still glow, violet-dominant at subliminal alpha', () => {
    expect((native.match(/<RadialGradient/g) ?? []).length).toBe(1);
    expect(native).toContain('GLOW');
    const glows = [...native.matchAll(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/g)];
    expect(glows.length).toBe(1);
    for (const match of glows) {
      const r = Number(match[1]);
      const g = Number(match[2]);
      const b = Number(match[3]);
      const a = Number(match[4]);
      expect(b).toBeGreaterThanOrEqual(r);
      expect(r).toBeGreaterThan(g);
      expect(a).toBeLessThanOrEqual(0.2);
    }
    // Fallback keeps a single still disc on the muted brand wash.
    expect(fallback).toContain('tokens.accentMuted');
    expect(fallback).toContain('styles.glow');
    expect(fallback).not.toContain('GlowOrb');
    expect(fallback).not.toContain('accentWarmMuted');
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
