// A switch's off track is a control boundary, not decoration: WCAG 1.4.11 puts
// non-text UI at 3:1 against its adjacent colour. The off track used the
// hairline `border` token (rgba white 0.08), which composites to about 1.2:1
// over a card — the switch read as a grey smudge and the only thing separating
// "off" from "not a control" was the thumb.

import { Palette } from '@/constants/tokens';

jest.mock('react-native-reanimated', () => {
  const ease = () => (value: number) => value;
  return {
    __esModule: true,
    Easing: { bezier: ease, elastic: ease, linear: (value: number) => value, out: (fn: unknown) => fn, in: (fn: unknown) => fn, inOut: (fn: unknown) => fn },
  };
});

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return 0.2126 * channel((n >> 16) & 0xff) + 0.7152 * channel((n >> 8) & 0xff) + 0.0722 * channel(n & 0xff);
}

/** Paint an `rgba(r, g, b, a)` token over an opaque hex surface. */
function over(ink: string, surface: string): number {
  const match = ink.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
  if (!match) throw new Error(`not an rgba token: ${ink}`);
  const [r, g, b, a] = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
  const n = Number.parseInt(surface.replace('#', ''), 16);
  const mix = (inkChannel: number, baseChannel: number) => Math.round(inkChannel * a + baseChannel * (1 - a));
  const hex = [mix(r, (n >> 16) & 0xff), mix(g, (n >> 8) & 0xff), mix(b, n & 0xff)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return luminance(`#${hex}`);
}

function contrast(inL: number, outL: number): number {
  const [lighter, darker] = inL > outL ? [inL, outL] : [outL, inL];
  return (lighter + 0.05) / (darker + 0.05);
}

const CARDS = ['backgroundElevated', 'backgroundRaised'] as const;

describe('the switch off track', () => {
  test('clears 3:1 against every card it sits on', () => {
    const ratios: Record<string, number> = {};
    for (const card of CARDS) {
      const ratio = contrast(over(Palette.controlTrackOff, Palette[card]), luminance(Palette[card]));
      ratios[card] = Number(ratio.toFixed(2));
    }
    expect(Object.values(ratios).every((ratio) => ratio >= 3)).toBe(true);
  });

  test('the hairline border token it replaced did not', () => {
    const ratio = contrast(over(Palette.border, Palette.backgroundElevated), luminance(Palette.backgroundElevated));
    expect(ratio).toBeLessThan(2);
  });
});
