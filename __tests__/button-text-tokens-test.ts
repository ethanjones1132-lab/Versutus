// tokens.ts only needs Easing for Motion curves; reanimated's native
// worklet unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));

declare const __dirname: string;

import { Palette } from '@/constants/tokens';

/**
 * Contract test for the Button/Text primitives token pass
 * (visual-direction-2026-09): controls sit on flat elevated stage panels with
 * cool hairlines, brand actions wear soft electric violet, primary type is
 * bright cool white — no champagne glass, no gold-as-brand anywhere in the
 * default Button/Text paths. Variant APIs (primary/secondary/ghost/destructive,
 * TextColor roles) are unchanged.
 */

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};
const SEP = __dirname.includes('\\') ? '\\' : '/';

function readSource(file: string): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'components', 'ui', file].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function hex(value: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(value);
  if (!m) throw new Error(`expected 6-digit hex, got ${value}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

describe('Button consumes the cool stage + violet brand tokens', () => {
  const src = readSource('Button.tsx');

  it('secondary sits on the flat elevated panel with a cool hairline, not glass', () => {
    expect(src).toContain('backgroundColor: tokens.backgroundElevated');
    expect(src).toContain('borderColor: tokens.border');
    expect(src).not.toMatch(/tokens\.glass\b|tokens\.glassBorder/);
  });

  it('primary wears the violet brand accent, not gold or champagne', () => {
    expect(src).toContain('backgroundColor: tokens.accent');
    expect(src).toContain('borderColor: tokens.accent');
    const [r, g, b] = hex(Palette.accent);
    expect(b).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(g);
    expect(src).not.toContain('Palette.gold');
  });

  it('the primary lift glow is violet, never champagne gold', () => {
    const glow = src.match(/boxShadow: '([^']+)'/)?.[1];
    expect(glow).toBeDefined();
    expect(glow).toContain('rgba(139,124,255');
    expect(glow).not.toContain('214,183,106');
    expect(glow).not.toMatch(/255,236,190|214,183,106/);
  });

  it('ghost text uses the brand accent role', () => {
    expect(src).toMatch(/color: 'accent' as const/);
  });

  it('keeps the public variant API (primary/secondary/ghost/destructive)', () => {
    for (const variant of ['primary', 'secondary', 'destructive']) {
      expect(src).toContain(`variant === '${variant}'`);
    }
    expect(src).toContain("variant = 'primary'");
  });
});

describe('Text color roles resolve onto the cool/violet palette', () => {
  const src = readSource('Text.tsx');

  it('every color role maps to an existing Palette key', () => {
    const block = src.slice(src.indexOf('const colorKey = {'), src.indexOf('} as const;', src.indexOf('const colorKey')));
    const keys = [...block.matchAll(/:\s*'(\w+)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(10);
    for (const key of keys) {
      expect(Palette).toHaveProperty(key);
    }
  });

  it('the default role is bright cool-white primary type', () => {
    expect(src).toContain("color = 'primary'");
    expect(src).toContain("primary: 'textPrimary'");
    const [r, g, b] = hex(Palette.textPrimary);
    expect(r).toBeGreaterThanOrEqual(0xe8);
    expect(g).toBeGreaterThanOrEqual(0xe8);
    expect(b).toBeGreaterThanOrEqual(0xe8);
    expect(b).toBeGreaterThanOrEqual(r);
  });

  it('accent roles are violet, and no role points at gold', () => {
    expect(src).toContain("accent: 'accent'");
    expect(src).toContain("accentWarm: 'accentWarm'");
    expect(src).not.toContain("'gold'");
    expect(src).not.toContain('goldMuted');
    const [ar, ag, ab] = hex(Palette.accent);
    expect(ab).toBeGreaterThan(ag);
    expect(ar).toBeGreaterThan(ag);
  });

  it('secondary/tertiary roles are cool grays, not parchment warmth', () => {
    const [, , sb] = hex(Palette.textSecondary);
    const [sr] = hex(Palette.textSecondary);
    expect(sb).toBeGreaterThanOrEqual(sr);
    const [tr] = hex(Palette.textTertiary);
    const [, , tb] = hex(Palette.textTertiary);
    expect(tb).toBeGreaterThanOrEqual(tr);
  });
});
