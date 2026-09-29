/**
 * The composer's light, as data: the colours the pill's bezel and the send
 * orb take from the room, and the one contrast decision the orb's glyph has
 * to make. Pure, so it is tested without a renderer.
 */

import type { BotCrestTone } from '@/lib/bot-avatar';

import { contrastRatio, hexToLinear, luminance } from './lamp';

/** `#RRGGBB` at an alpha, as the platforms' colour strings want it. */
export function hexAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Number(a.toFixed(3))})`;
}

/**
 * The orb is cut as a deep stone with a bright sheen: its body runs from the
 * crest's lit stop at the upper-left edge through a stop already most of the
 * way to the deep one, so the centre — where the glyph sits — is the deep
 * colour, and the light lives in the sheen. These are the body's stops.
 */
export const ORB_BODY_STOPS = [
  { offset: 0, toward: 0 },
  { offset: 0.3, toward: 0.45 },
  { offset: 1, toward: 1 },
] as const;

/** A colour part-way from one sRGB hex to another, mixed in sRGB as SVG does. */
export function mixHex(from: string, to: string, t: number): string {
  const a = parseInt(from.slice(1, 7), 16);
  const b = parseInt(to.slice(1, 7), 16);
  const channel = (shift: number) => Math.round(((a >> shift) & 255) + ((((b >> shift) & 255) - ((a >> shift) & 255)) * t));
  return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** Where the body's gradient sits at the orb's centre (t = 0.5 on its axis). */
function orbCentreToward(): number {
  const [, mid, end] = ORB_BODY_STOPS;
  const u = (0.5 - mid.offset) / (end.offset - mid.offset);
  return mid.toward + (end.toward - mid.toward) * u;
}

/** The orb's centre — the colour its glyph is read against. */
function orbMidLuminance(tone: BotCrestTone): number {
  return luminance(hexToLinear(mixHex(tone.from, tone.to, orbCentreToward())));
}

/** WCAG's floor for a meaningful glyph against what it sits on (non-text contrast). */
export const ORB_GLYPH_MIN_CONTRAST = 3;

/**
 * Whether the send glyph is drawn dark. A white arrow is the jewel's own —
 * it stays white whenever it clears the 3:1 an icon needs; only an orb too
 * pale for that (platinum's moonlight) takes the stage's near-black instead.
 */
export function orbGlyphIsDark(tone: BotCrestTone): boolean {
  return contrastRatio(1, orbMidLuminance(tone)) < ORB_GLYPH_MIN_CONTRAST;
}

/** The contrast the chosen glyph keeps against the orb's middle. */
export function orbGlyphContrast(tone: BotCrestTone): number {
  const mid = orbMidLuminance(tone);
  return orbGlyphIsDark(tone) ? contrastRatio(luminance(hexToLinear('#0A0A0B')), mid) : contrastRatio(1, mid);
}
