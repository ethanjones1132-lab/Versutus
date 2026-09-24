// tokens.ts only needs Easing for Motion curves; reanimated's native
// worklet unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));

declare const __dirname: string;

import { Palette } from '@/constants/tokens';

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function readBaseSheet(): string {
  return readSource(['src', 'components', 'ui', 'BaseSheet.tsx']);
}

/**
 * Contract test for the sheet-language pass (CHARTER priority 4,
 * visual-direction-2026-09): BaseSheet is one flat raised panel with a cool
 * hairline, brand-violet eyebrow, bright-white title, and the shared scrim
 * token. Glass remains an explicit opt-in; open/close and confirm flows are
 * untouched.
 */

describe('BaseSheet renders the flat modal material', () => {
  test('the sheet surface is the hero variant with no warm border override', () => {
    const src = readBaseSheet();
    expect(src).toContain('variant="hero"');
    // No inline borderColor: the hero variant supplies the cool borderStrong
    // hairline from glass-variants; the old accentWarmMuted override is gone.
    expect(src).not.toContain('borderColor:');
    expect(src).not.toContain('accentWarmMuted');
  });

  test('no focus-tint violet survives anywhere in the sheet chrome', () => {
    const src = readBaseSheet();
    expect(src).not.toMatch(/accentWarm/);
    expect(src).not.toMatch(/Palette\.gold|tokens\.gold/);
  });

  test('glass stays an explicit opt-in that defaults to flat', () => {
    const src = readBaseSheet();
    expect(src).toMatch(/glass = false/);
    expect(src).toContain('glass={glass}');
    expect(src).toMatch(/glass\?: boolean;/);
  });

  test('the scrim resolves from the shared Palette overlay token', () => {
    const src = readBaseSheet();
    expect(src).toContain('backgroundColor: Palette.overlay');
    expect(src).not.toContain("backgroundColor: 'rgba(0,0,0,0.6)'");
    expect(src).toContain('Palette, Radius');
  });
});

describe('BaseSheet header lands on the violet/white type system', () => {
  test('the eyebrow wears brand violet, not the brighter focus tint', () => {
    const src = readBaseSheet();
    expect(src).toContain('color="accent"');
    expect(src).not.toContain('color="accentWarm"');
    // Eyebrow still renders the caller-supplied label (default ACTION).
    expect(src).toContain("eyebrow = 'ACTION'");
    expect(src).toContain('{eyebrow}');
  });

  test('the title stays bright primary white with no colour override', () => {
    const src = readBaseSheet();
    // <Text variant="title"> with no color prop resolves to textPrimary.
    expect(src).toMatch(/<Text variant="title"(?![^>]*color=)/);
  });

  test('brand accent is violet and gold stays out of the accent role', () => {
    const [r, g, b] = (Palette.accent.match(/\w\w/g) ?? []).map((hex) => parseInt(hex, 16));
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
    expect(Palette.accent).not.toBe(Palette.gold);
    expect(Palette.overlay).toBe('rgba(0, 0, 0, 0.62)');
  });
});

describe('BaseSheet open/close and confirm flows are untouched', () => {
  test('lazy mount, backdrop dismiss and haptics close still stand', () => {
    const src = readBaseSheet();
    expect(src).toContain('if (!mounted) return null;');
    expect(src).toContain('accessibilityLabel="Dismiss sheet"');
    expect(src).toContain('Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)');
    expect(src).toContain('onRequestClose={onClose}');
  });

  test('the slide animation and keyboard-lift wiring are unchanged', () => {
    const src = readBaseSheet();
    expect(src).toContain('translateY.value = withTiming(');
    expect(src).toContain('duration: Motion.duration.normal,');
    expect(src).toContain('runOnJS(setMounted)(false)');
    expect(src).toContain('keyboardHeight,');
  });

  test('ConfirmSheet still renders through BaseSheet', () => {
    const confirm = readSource(['src', 'components', 'ui', 'ConfirmSheet.tsx']);
    expect(confirm).toContain("import { BaseSheet } from './BaseSheet'");
    expect(confirm).toContain('<BaseSheet visible={visible}');
  });
});
