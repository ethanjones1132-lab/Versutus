// tokens.ts only needs Easing for Motion curves; reanimated's native
// worklet unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));

// iOS surface pulls the native liquid-glass view; stand it in as a host
// component so the default (flat) path can be asserted by its absence.
jest.mock('expo-glass-effect', () => ({
  GlassView: 'GlassView',
}));

declare const __dirname: string;

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { StyleSheet, View } from 'react-native';

import { Palette } from '@/constants/tokens';
import { GlassSurface } from '@/components/ui/GlassSurface';

const SEP = __dirname.includes('\\') ? '\\' : '/';

// Stand-in host name for the mocked expo-glass-effect view; not a real
// JSX intrinsic, so it needs an ElementType cast for findAllByType.
const GLASS_VIEW = 'GlassView' as ElementType;

/**
 * Contract test for the flat-defaults pass (visual-direction-2026-09) and the
 * S4b hairline drop on top of it: the default GlassSurface material on every
 * platform is a flat elevated panel that draws **no border at all** — the
 * widened elevation step separates it from the stage. Glass (iOS liquid glass,
 * web backdrop blur) exists only behind the explicit `glass` opt-in for
 * sheets/modals. A consumer that genuinely needs an edge declares its own
 * `borderWidth` in its own style and that wins. Props API is unchanged apart
 * from the additive optional `glass` flag.
 */

const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(file: string): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'components', 'ui', file].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

async function renderSurface(
  props: Partial<Parameters<typeof GlassSurface>[0]> = {},
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(GlassSurface, { children: 'body', ...props } as Parameters<
        typeof GlassSurface
      >[0]),
    );
  });
  return renderer;
}

describe('GlassSurface defaults to a flat elevated panel', () => {
  let renderer: ReactTestRenderer | undefined;
  afterEach(async () => {
    if (renderer) {
      const doomed = renderer;
      renderer = undefined;
      await act(async () => {
        doomed.unmount();
      });
    }
  });

  it('renders no liquid-glass view unless glass is opted in', async () => {
    renderer = await renderSurface();
    expect(renderer.root.findAllByType(GLASS_VIEW)).toHaveLength(0);
  });

  it('still renders the liquid-glass view behind the glass opt-in', async () => {
    renderer = await renderSurface({ glass: true });
    expect(renderer.root.findAllByType(GLASS_VIEW)).toHaveLength(1);
  });

  it('paints the surface variant as an opaque, borderless stage panel', async () => {
    const stagePanels = [
      [undefined, Palette.backgroundElevated, Palette.border],
      ['hero', Palette.backgroundRaised, Palette.borderStrong],
      ['inset', Palette.backgroundInset, Palette.borderSubtle],
    ] as const;
    for (const [variant, background, border] of stagePanels) {
      const current = await renderSurface(variant ? { variant } : {});
      renderer = current;
      const surface = current.root.findByType(View);
      const style = StyleSheet.flatten(surface.props.style);
      expect(style.backgroundColor).toBe(background);
      expect(style.borderColor).toBe(border);
      // S4b: the value step carries the card, so nothing is drawn on its edge.
      expect(style.borderWidth).toBe(0);
      // Opaque stage color — never a translucent glass tier or gold.
      expect(style.backgroundColor).not.toMatch(/rgba\([^)]+,\s*0?\.\d+\)/);
      expect(style.backgroundColor).not.toBe(Palette.glass);
      expect(style.backgroundColor).not.toBe(Palette.glassHero);
      expect(style.backgroundColor).not.toBe(Palette.gold);
      await act(async () => {
        current.unmount();
      });
      renderer = undefined;
    }
    // Chip is the one intentionally tinted (violet accent) variant, and it is
    // borderless too — the connection pill declares its own edge when pairing.
    renderer = await renderSurface({ variant: 'chip' });
    const chipStyle = StyleSheet.flatten(renderer.root.findByType(View).props.style);
    expect(chipStyle.backgroundColor).toBe(Palette.accentMuted);
    expect(chipStyle.borderColor).toBe(Palette.accentWarmMuted);
    expect(chipStyle.borderWidth).toBe(0);
  });

  it('leaves an edge to the consumer that needs one', async () => {
    // Sheets, focused inputs, selected rows and failure cards all rely on this:
    // the default is silent, and a declared width/colour overrides it.
    renderer = await renderSurface({
      style: { borderWidth: 2, borderColor: Palette.accent },
    });
    const style = StyleSheet.flatten(renderer.root.findByType(View).props.style);
    expect(style.borderWidth).toBe(2);
    expect(style.borderColor).toBe(Palette.accent);
  });

  it('keeps the existing props API alongside the additive glass flag', async () => {
    renderer = await renderSurface({
      variant: 'hero',
      radius: 18,
      padding: 16,
      interactive: true,
      style: { margin: 4 },
    });
    const surface = renderer.root.findByType(View);
    const style = StyleSheet.flatten(surface.props.style);
    expect(style.borderRadius).toBe(18);
    expect(style.padding).toBe(16);
    expect(style.margin).toBe(4);
  });
});

describe('platform sources gate every blur behind the glass opt-in', () => {
  it('web applies backdrop blur only when glass is true', () => {
    const src = readSource('GlassSurface.web.tsx');
    expect(src).toContain('glass ? webGlass : null');
    // The blur object may exist, but must never sit unconditionally in the
    // style array ahead of the variant colors.
    expect(src).not.toMatch(/style=\{\[\s*styles\.surface,\s*webGlass,/);
  });

  it('the Android/default surface has no blur or glass primitive at all', () => {
    const src = readSource('GlassSurface.tsx');
    expect(src).not.toContain('backdropFilter');
    expect(src).not.toContain('GlassView');
    expect(src).not.toContain('expo-glass-effect');
  });

  it('iOS reaches GlassView only inside the glass branch', () => {
    const src = readSource('GlassSurface.ios.tsx');
    expect(src).toContain('if (!glass)');
    expect(src).toContain('glass = false');
    // After the early flat return, GlassView is the glass-path root.
    const flatReturn = src.indexOf('if (!glass)');
    const glassView = src.indexOf('<GlassView');
    expect(flatReturn).toBeGreaterThan(-1);
    expect(glassView).toBeGreaterThan(flatReturn);
  });

  it('the glass flag is optional on the shared props type', () => {
    const src = readSource('types.ts');
    expect(src).toMatch(/glass\?: boolean;/);
  });

  it('no platform surface hardcodes a default hairline (S4b)', () => {
    // The base style carries no width at all; each platform reads the width
    // from the variant map, which is where the borderless decision lives.
    for (const file of ['GlassSurface.tsx', 'GlassSurface.ios.tsx', 'GlassSurface.web.tsx']) {
      const src = readSource(file);
      expect(src).toContain('borderWidth: variantStyle.borderWidth');
      expect(src).not.toMatch(/borderWidth: StyleSheet\.hairlineWidth/);
    }
  });
});
