/**
 * The colour wheel, as maths. A Bot's colour is two hues: the **lit** hue its
 * stone shows where the lamp strikes it, and the **shade** hue it falls into
 * underneath. Each is read off its own ring of the wheel at a fixed OKLCH
 * lightness, so every hue on a ring is the same brightness to the eye — a
 * Bot can be any colour and still sit on the stage like a jewel, not a
 * sticker.
 *
 * The wheel is whole but for three seams. Mint, amber and red are how the
 * app says connected, waiting and failed; the hues right at those three are
 * sealed, so no Bot can wear a status colour and read as one.
 */

import type { BotCrestTone } from '@/lib/bot-avatar';
import {
  STATUS_HUES_OKLCH,
  hexToLinear,
  linearToOklch,
  linearToSrgb,
  oklchToLinear,
  type Rgb,
} from '@/lib/stage/lamp';

export type WheelRing = 'lit' | 'shade';

/** The lightness each ring sits at, and the most colour it asks of a hue. */
export const WHEEL_RINGS: Record<WheelRing, { l: number; c: number }> = {
  lit: { l: 0.8, c: 0.14 },
  shade: { l: 0.47, c: 0.17 },
};

/** How far either side of a status hue the wheel is sealed, in OKLCH degrees. */
export const WHEEL_SEAM = 14;

/** The three seams, in the order the app's status reads: failed, waiting, connected. */
export const WHEEL_SEAMS = [
  { status: 'failed', hue: STATUS_HUES_OKLCH[0] },
  { status: 'waiting', hue: STATUS_HUES_OKLCH[1] },
  { status: 'connected', hue: STATUS_HUES_OKLCH[2] },
] as const;

export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export function wrapHue(hue: number): number {
  return ((hue % 360) + 360) % 360;
}

/** Whether a hue falls inside one of the three sealed seams. */
export function isSeamHue(hue: number): boolean {
  return WHEEL_SEAMS.some((seam) => hueDistance(hue, seam.hue) < WHEEL_SEAM);
}

/** A hue steered out of a seam to the nearer of its two edges; open hues are kept. */
export function openHue(hue: number): number {
  const h = wrapHue(hue);
  for (const seam of WHEEL_SEAMS) {
    if (hueDistance(h, seam.hue) < WHEEL_SEAM) {
      // A hair past the edge, so the float arithmetic cannot land back inside.
      const below = wrapHue(seam.hue - WHEEL_SEAM - 0.01);
      const above = wrapHue(seam.hue + WHEEL_SEAM + 0.01);
      return hueDistance(h, below) <= hueDistance(h, above) ? below : above;
    }
  }
  return h;
}

function inGamut(rgb: Rgb): boolean {
  return rgb.every((v) => v >= -0.0005 && v <= 1.0005);
}

export function linearToHex(rgb: Rgb): string {
  return `#${rgb
    .map((v) => Math.round(Math.min(1, Math.max(0, linearToSrgb(Math.min(1, Math.max(0, v))))) * 255))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

/**
 * A ring's colour at a hue: its lightness, and as much of its chroma as the
 * screen can show at that hue. Chroma is given up rather than hue or
 * lightness, so the ring stays even in brightness and true in hue.
 */
export function wheelColour(ring: WheelRing, hue: number): string {
  const { l, c } = WHEEL_RINGS[ring];
  const h = wrapHue(hue);
  if (inGamut(oklchToLinear({ l, c, h }))) return linearToHex(oklchToLinear({ l, c, h }));
  let low = 0;
  let high = c;
  for (let step = 0; step < 18; step += 1) {
    const mid = (low + high) / 2;
    if (inGamut(oklchToLinear({ l, c: mid, h }))) low = mid;
    else high = mid;
  }
  return linearToHex(oklchToLinear({ l, c: low, h }));
}

/** The stone a pair of hues cuts: the lit ring's colour into the shade ring's. */
export function toneFromHues(lit: number, shade: number): BotCrestTone {
  return { from: wheelColour('lit', openHue(lit)), to: wheelColour('shade', openHue(shade)) };
}

/** The hue a colour sits at on the wheel. */
export function hueOf(hex: string): number {
  return linearToOklch(hexToLinear(hex)).h;
}

/** Where a tone's two stops sit on the wheel's two rings. */
export function huesOfTone(tone: BotCrestTone): { lit: number; shade: number } {
  return { lit: openHue(hueOf(tone.from)), shade: openHue(hueOf(tone.to)) };
}

/** Names for the open wheel, by the hue each one centres on. */
const HUE_NAMES: readonly (readonly [number, string])[] = [
  [0, 'Raspberry'],
  [48, 'Coral'],
  [112, 'Chartreuse'],
  [135, 'Lime'],
  [188, 'Teal'],
  [205, 'Lagoon'],
  [228, 'Ocean'],
  [250, 'Azure'],
  [266, 'Cobalt'],
  [288, 'Violet'],
  [308, 'Orchid'],
  [328, 'Mulberry'],
  [346, 'Rose'],
];

/** The nearest name for a hue on the wheel. */
export function hueName(hue: number): string {
  let best = HUE_NAMES[0];
  for (const entry of HUE_NAMES) {
    if (hueDistance(hue, entry[0]) < hueDistance(hue, best[0])) best = entry;
  }
  return best[1];
}

/** What a pair of hues is called: one name, or the lit name falling into the shade's. */
export function toneName(lit: number, shade: number): string {
  const top = hueName(lit);
  const under = hueName(shade);
  return top === under ? top : `${top} into ${under}`;
}
