// tokens.ts only needs Easing for Motion curves; reanimated's native
// worklet unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));

import { Palette } from '@/constants/tokens';

/**
 * Contract test for the visual-direction-2026-09 token pass: cool near-black
 * stage, bright cool-white type, soft electric violet brand, metallic gold as
 * a separate rare highlight. Keys consumed by useTokens()/primitives must not
 * disappear (no API breakage).
 */

function hex(value: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(value);
  if (!m) throw new Error(`expected 6-digit hex, got ${value}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const REQUIRED_KEYS = [
  'background',
  'backgroundInset',
  'backgroundElevated',
  'backgroundRaised',
  'glass',
  'glassBorder',
  'glassHighlight',
  'glassHero',
  'glassHeroBorder',
  'textPrimary',
  'textSecondary',
  'textTertiary',
  'textInverse',
  'accent',
  'accentMuted',
  'accentWarm',
  'accentWarmMuted',
  'statusConnected',
  'statusConnectedMuted',
  'statusConnecting',
  'statusDisconnected',
  'statusDisconnectedMuted',
  'statusPairing',
  'border',
  'borderSubtle',
  'borderStrong',
  'overlay',
] as const;

const STAGE_KEYS = [
  'background',
  'backgroundInset',
  'backgroundElevated',
  'backgroundRaised',
] as const;

describe('Palette token contract', () => {
  it('keeps every key consumed by useTokens() and primitives', () => {
    for (const key of REQUIRED_KEYS) {
      expect(typeof Palette[key]).toBe('string');
      expect(Palette[key].length).toBeGreaterThan(0);
    }
  });

  it('stage is cool near-black (blue channel not below red)', () => {
    for (const key of STAGE_KEYS) {
      const [r, g, b] = hex(Palette[key]);
      expect(b).toBeGreaterThanOrEqual(r);
      expect(b).toBeGreaterThanOrEqual(g);
      expect(r).toBeGreaterThanOrEqual(0x0a);
      expect(b).toBeLessThanOrEqual(0x20);
      expect(g).toBeLessThanOrEqual(0x20);
    }
  });

  it('primary type is bright cool white, secondary is cool gray', () => {
    const [r, g, b] = hex(Palette.textPrimary);
    expect(r).toBeGreaterThanOrEqual(0xe8);
    expect(g).toBeGreaterThanOrEqual(0xe8);
    expect(b).toBeGreaterThanOrEqual(0xe8);
    expect(b).toBeGreaterThanOrEqual(r);
    const [sr, , sb] = hex(Palette.textSecondary);
    expect(sb).toBeGreaterThanOrEqual(sr);
  });

  it('brand accent is soft electric violet, not gold', () => {
    const [r, g, b] = hex(Palette.accent);
    expect(b).toBeGreaterThanOrEqual(0xf0);
    expect(b).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(g);
    const [wr, wg, wb] = hex(Palette.accentWarm);
    expect(wb).toBeGreaterThanOrEqual(wr);
    expect(wr).toBeGreaterThan(wg);
  });

  it('exposes a metallic gold highlight separate from the brand accent', () => {
    expect(Palette.gold).toBeDefined();
    expect(Palette.goldMuted).toBeDefined();
    expect(Palette.gold).not.toBe(Palette.accent);
    const [r, g, b] = hex(Palette.gold);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });

  it('keeps semantic status colors distinct from brand violet', () => {
    for (const key of [
      'statusConnected',
      'statusDisconnected',
    ] as const) {
      expect(Palette[key]).not.toBe(Palette.accent);
      expect(Palette[key]).not.toBe(Palette.gold);
    }
    const [cr, cg, cb] = hex(Palette.statusConnected);
    expect(cg).toBeGreaterThan(cr);
    expect(cg).toBeGreaterThan(cb);
    const [dr, , db] = hex(Palette.statusDisconnected);
    expect(dr).toBeGreaterThan(db);
  });
});
