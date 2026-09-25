// tokens.ts only needs Easing for Motion curves; reanimated's native
// worklet unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));

declare const __dirname: string;

import { Palette } from '@/constants/tokens';
import { glassVariantStyles } from '@/components/ui/glass-variants';

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
  readdirSync(
    path: string,
    options: { encoding: 'utf8'; recursive: true },
  ): string[];
};
const ROOT = [__dirname, '..'].join(SEP);

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([ROOT, ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

/**
 * Contract test for the flatten-glass pass (visual-direction-2026-09) and the
 * S4b hairline drop that followed it: the shared surface variants resolve to
 * solid cool near-black stage panels, never translucent champagne glass and
 * never gold, and they ship **no edge at all** — the elevation step is what
 * separates a card from the stage. The cool hairline colour stays in the map
 * because it is the value a surface reaches for the moment a consumer decides
 * it genuinely needs an edge. Variant name API (hero/surface/inset/chip) must
 * not change.
 */

type Rgba = { r: number; g: number; b: number; a: number };

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(value);
  if (rgba) {
    return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]), a: Number(rgba[4]) };
  }
  throw new Error(`unparseable color: ${value}`);
}

const VARIANTS = ['hero', 'surface', 'inset', 'chip'] as const;

describe('glassVariantStyles flatten contract', () => {
  it('keeps the variant name API', () => {
    expect(Object.keys(glassVariantStyles).sort()).toEqual([...VARIANTS].sort());
  });

  it('hero/surface/inset are opaque stage panels, not translucent glass tiers', () => {
    const expected: Record<'hero' | 'surface' | 'inset', string> = {
      hero: Palette.backgroundRaised,
      surface: Palette.backgroundElevated,
      inset: Palette.backgroundInset,
    };
    for (const variant of ['hero', 'surface', 'inset'] as const) {
      const { backgroundColor, borderColor } = glassVariantStyles[variant];
      expect(backgroundColor).toBe(expected[variant]);
      expect(parseColor(backgroundColor).a).toBe(1);
      expect(backgroundColor).not.toBe(Palette.glass);
      expect(backgroundColor).not.toBe(Palette.glassHero);
      expect(borderColor).not.toBe(Palette.glassHeroBorder);
      // Palette.border currently shares its value with glassBorder, so
      // value checks can't tell them apart — the source-level test below
      // pins that the map never names a glass tier.
      expect([Palette.border, Palette.borderStrong, Palette.borderSubtle]).toContain(
        borderColor,
      );
    }
  });

  it('never names a glass tier in the variant source', () => {
    const src = readSource('src', 'components', 'ui', 'glass-variants.ts');
    const mapping = src.slice(src.indexOf('export const glassVariantStyles'));
    expect(mapping).not.toMatch(/Palette\.glass/);
    expect(mapping).not.toMatch(/Palette\.gold/);
  });

  it('reserves glassBorder for the token and deliberate glass sheets', () => {
    const violations = nodeFs
      .readdirSync([ROOT, 'src'].join(SEP), { encoding: 'utf8', recursive: true })
      .map((path) => path.replace(/\\/g, '/'))
      .filter((path) => /\.(?:ts|tsx)$/.test(path))
      .filter((path) => path !== 'constants/tokens.ts')
      .filter((path) => !/(?:^|\/)[^/]*sheet[^/]*$/i.test(path))
      .filter((path) => readSource('src', ...path.split('/')).includes('glassBorder'));
    expect(violations).toEqual([]);
  });

  it('every variant border is a cool hairline (blue channel not below red)', () => {
    for (const variant of VARIANTS) {
      const { r, b, a } = parseColor(glassVariantStyles[variant].borderColor);
      expect(b).toBeGreaterThanOrEqual(r);
      expect(a).toBeGreaterThan(0);
      expect(a).toBeLessThan(1);
    }
  });

  it('no default surface or border is gold or warm champagne', () => {
    for (const variant of VARIANTS) {
      for (const value of [
        glassVariantStyles[variant].backgroundColor,
        glassVariantStyles[variant].borderColor,
      ]) {
        expect(value).not.toBe(Palette.gold);
        expect(value).not.toBe(Palette.goldMuted);
        const { r, g, b } = parseColor(value);
        // Gold/champagne signature: red > green > blue.
        const warmGold = r > g && g > b;
        expect(warmGold).toBe(false);
      }
    }
  });

  it('chip stays on the violet accent pair', () => {
    expect(glassVariantStyles.chip.backgroundColor).toBe(Palette.accentMuted);
    expect(glassVariantStyles.chip.borderColor).toBe(Palette.accentWarmMuted);
  });

  it('draws no edge: every variant ships borderWidth 0 (S4b)', () => {
    // The wireframe habit was the shared surface ringing itself around every
    // card on the stage. Now the elevation step carries the card and a ring is
    // something a consumer declares in its own style, where it means an
    // affordance (a focused input, a selected row, a failure, a floating
    // sheet) instead of decoration.
    for (const variant of VARIANTS) {
      expect(glassVariantStyles[variant].borderWidth).toBe(0);
    }
  });

  it('keeps the cool hairline colour in the map for consumers that need an edge', () => {
    // Dropping the default width is not dropping the palette: the colour each
    // variant would ring with is still there, and it is still cool.
    for (const variant of VARIANTS) {
      const { r, b, a } = parseColor(glassVariantStyles[variant].borderColor);
      expect(b).toBeGreaterThanOrEqual(r);
      expect(a).toBeGreaterThan(0);
      expect(a).toBeLessThan(1);
    }
  });
});
