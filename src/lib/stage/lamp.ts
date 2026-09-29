/**
 * The lamp — Nocturne's stage light, as a model (no rendering here).
 *
 * The stage is a dark room lit by one lamp above the top edge. Its light
 * takes the colour of whoever the operator is talking to: the same two stops
 * as that Bot's crest, so the crest and the room read as one material. A group
 * room hangs one lamp per member.
 *
 * Every colour the renderers draw is budgeted here. A lamp colour is its crest
 * stop deepened and then scaled to one fixed luminance, so every room is lit
 * equally bright and only the hue changes. The renderers pass all light
 * through one saturating curve (1 − e^−x), so no pixel can exceed the stage
 * base plus one lamp colour. That ceiling keeps the dimmest words on the
 * stage (`textTertiary`) at WCAG AA everywhere, under the brightest pixel the
 * lamp can reach. See `stageCeilingContrast` and __tests__/stage-lamp-test.ts.
 *
 * Pure, engine-independent, and worklet-safe where the native renderer
 * calls it on the UI thread.
 */

import { BOT_CREST_TONES, botCrestFromId, type BotCrestTone } from '@/lib/bot-avatar';

export type Rgb = readonly [number, number, number];

/** `Palette.background` — the stage the lamp lights (asserted equal in tests). */
export const STAGE_BASE_HEX = '#0A0A0B';
/** `Palette.textTertiary` — the dimmest words that sit directly on the stage. */
export const STAGE_TEXT_FLOOR_HEX = '#8A8F98';

/** WCAG AA for body-size text. */
const AA_BODY = 4.5;
/**
 * The share of the ceiling the lamp may spend. The rest is headroom for the
 * dither (one 8-bit step either way) and float error on the GPU.
 */
const CEILING_HEADROOM = 0.86;

/**
 * Status hues in OKLCH degrees (`Palette.statusFailed` red, `statusConnecting`
 * amber, `statusConnected` mint). A room lit near one of them would read as
 * that state — a crimson room reads as an error — so lamp hues keep clear.
 */
export const STATUS_HUES_OKLCH = [21.9, 88.1, 163.3] as const;
/** How far, in OKLCH degrees, every lamp hue keeps from every status hue. */
export const STATUS_HUE_CLEARANCE = 45;

export function srgbToLinear(value: number): number {
  'worklet';
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(value: number): number {
  'worklet';
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

export function hexToLinear(hex: string): Rgb {
  const n = parseInt(hex.slice(1, 7), 16);
  return [
    srgbToLinear(((n >> 16) & 255) / 255),
    srgbToLinear(((n >> 8) & 255) / 255),
    srgbToLinear((n & 255) / 255),
  ];
}

/** WCAG relative luminance of a linear-light colour. */
export function luminance(rgb: Rgb): number {
  'worklet';
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/** WCAG contrast ratio between two relative luminances. */
export function contrastRatio(a: number, b: number): number {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

export const STAGE_BASE: Rgb = hexToLinear(STAGE_BASE_HEX);

/**
 * The brightest the stage may ever be: the luminance at which the dimmest
 * text on it still holds 4.5:1.
 */
export const STAGE_CEILING = (luminance(hexToLinear(STAGE_TEXT_FLOOR_HEX)) + 0.05) / AA_BODY - 0.05;

/** The luminance one lamp colour carries, after the base and the headroom. */
export const STAGE_LIGHT_BUDGET = (STAGE_CEILING - luminance(STAGE_BASE)) * CEILING_HEADROOM;

// ── OKLab: light is chosen by eye, then held to the budget by the numbers ──

type Oklch = { l: number; c: number; h: number };

export function linearToOklch(rgb: Rgb): Oklch {
  const l = Math.cbrt(0.4122214708 * rgb[0] + 0.5363325363 * rgb[1] + 0.0514459929 * rgb[2]);
  const m = Math.cbrt(0.2119034982 * rgb[0] + 0.6806995451 * rgb[1] + 0.1073969566 * rgb[2]);
  const s = Math.cbrt(0.0883024619 * rgb[0] + 0.2817188376 * rgb[1] + 0.6299787005 * rgb[2]);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return { l: L, c: Math.hypot(a, b), h: h < 0 ? h + 360 : h };
}

export function oklchToLinear({ l, c, h }: Oklch): Rgb {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l3 = Math.pow(l + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m3 = Math.pow(l - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s3 = Math.pow(l - 0.0894841775 * a - 1.291485548 * b, 3);
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * A crest hue made safe to light a room with: a hue inside a status guard band
 * is steered to the nearest edge of the band, so raspberry becomes a deep rose
 * rather than a crimson that reads as failure.
 */
export function guardLampHue(hue: number): number {
  for (const status of STATUS_HUES_OKLCH) {
    if (hueDistance(hue, status) < STATUS_HUE_CLEARANCE) {
      const below = (status - STATUS_HUE_CLEARANCE + 360) % 360;
      const above = (status + STATUS_HUE_CLEARANCE) % 360;
      return hueDistance(hue, below) <= hueDistance(hue, above) ? below : above;
    }
  }
  return hue;
}

/** The lightness at which this hue and chroma carry exactly `target` luminance, or null if out of gamut. */
function atLuminance(hue: number, chroma: number, target: number): Rgb | null {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (luminance(oklchToLinear({ l: mid, c: chroma, h: hue })) < target) lo = mid;
    else hi = mid;
  }
  const rgb = oklchToLinear({ l: (lo + hi) / 2, c: chroma, h: hue });
  return rgb.every((channel) => channel >= -1e-7) ? (rgb.map((v) => Math.max(0, v)) as unknown as Rgb) : null;
}

/**
 * A crest stop as stage light. It keeps its hue (steered clear of status
 * hues), takes `chromaScale` of the stop's own chroma so a grey crest stays
 * moonlight and a vivid one stays vivid, and is carried at exactly the
 * stage's light budget, so every lamp in every room is equally bright.
 * Chroma steps down only as far as the sRGB gamut forces it at that level.
 */
export function lampLight(hex: string, chromaScale: number, chromaFloor: number = 0): Rgb {
  const { c, h } = linearToOklch(hexToLinear(hex));
  const hue = guardLampHue(h);
  // A crest that is deliberately grey (platinum) stays moonlight; every other
  // crest is lit at least vividly enough to read as its colour in the dark.
  const floor = c < NEUTRAL_CREST_CHROMA ? 0 : chromaFloor;
  let chroma = Math.min(LAMP_MAX_CHROMA, Math.max(floor, c * chromaScale));
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const rgb = atLuminance(hue, chroma, STAGE_LIGHT_BUDGET);
    if (rgb) return rgb;
    chroma *= 0.9;
  }
  return [STAGE_LIGHT_BUDGET, STAGE_LIGHT_BUDGET, STAGE_LIGHT_BUDGET];
}

/** No lamp is more saturated than this, whatever its crest. */
const LAMP_MAX_CHROMA = 0.16;
/** Below this OKLCH chroma a crest is grey on purpose, and its light stays grey. */
const NEUTRAL_CREST_CHROMA = 0.04;
/** Every coloured lamp is at least this vivid at the fringe, and at the core. */
export const LAMP_EDGE_FLOOR = 0.105;
export const LAMP_CORE_FLOOR = 0.07;
/** The fringe of a pool: the crest's deep stop, nearly as saturated as it is. */
export const LAMP_EDGE_CHROMA = 0.78;
/** The hot core: the crest's lit stop, paler, the way bright light washes out. */
export const LAMP_CORE_CHROMA = 0.85;

/**
 * The contrast the dimmest stage text keeps under the brightest pixel the
 * given light colour can produce (base + the full colour, plus one dither step).
 */
export function stageCeilingContrast(light: Rgb, ditherSteps: number = 1): number {
  const lifted = [0, 1, 2].map((i) => {
    const srgb = linearToSrgb(STAGE_BASE[i] + light[i]) + ditherSteps / 255;
    return srgbToLinear(Math.min(1, srgb));
  }) as unknown as Rgb;
  return contrastRatio(luminance(hexToLinear(STAGE_TEXT_FLOOR_HEX)), luminance(lifted));
}

// ── Rooms ────────────────────────────────────────────────────────────────

/** Where the operator is standing, as far as the light is concerned. */
export type StageRoom =
  /** The roster, Activity, Tools, Settings: the house's own violet. */
  | { kind: 'lobby' }
  /** A direct chat: the operator and a model, no Bot in between. */
  | { kind: 'direct' }
  /** One Bot's thread, lit in that Bot's crest tone. */
  | { kind: 'bot'; botId: string; name?: string }
  /** A group room, one lamp per member (up to three). */
  | { kind: 'room'; memberIds: readonly string[] };

/** One stable string per room, so a renderer can tell a real change apart. */
export function stageRoomKey(room: StageRoom | undefined): string {
  if (!room) return 'lobby';
  switch (room.kind) {
    case 'bot':
      return `bot:${room.botId}`;
    case 'room':
      return `room:${room.memberIds.slice(0, 3).join(',')}`;
    default:
      return room.kind;
  }
}

/** One lamp: its two colours, where it hangs (width units, y down), its reach and strength. */
export type StageLamp = {
  core: Rgb;
  edge: Rgb;
  x: number;
  y: number;
  radius: number;
  gain: number;
};

export type StageLights = {
  key: StageLamp;
  guestA: StageLamp;
  guestB: StageLamp;
};

/**
 * Where the lamps hang, in width units from the top-left corner, y down —
 * above the top edge, so the source is never seen, only its light. The key
 * hangs over the upper left: the same light that pools a sheen on the upper
 * left of every crest.
 */
export const LAMP_SEATS = {
  key: { x: 0.3, y: -0.2, radius: 1.0 },
  /** A group room seats its members across the ceiling: left, right, centre-high. */
  roomKey: { x: 0.1, y: -0.14, radius: 0.62 },
  guestA: { x: 0.92, y: -0.12, radius: 0.6 },
  guestB: { x: 0.5, y: -0.3, radius: 0.56 },
} as const;

/** The house light: the brand's own crest tone. */
export const BRAND_TONE: BotCrestTone = BOT_CREST_TONES[0];

function lampFrom(tone: BotCrestTone, seat: { x: number; y: number; radius: number }, gain: number): StageLamp {
  return {
    core: lampLight(tone.from, LAMP_CORE_CHROMA, LAMP_CORE_FLOOR),
    edge: lampLight(tone.to, LAMP_EDGE_CHROMA, LAMP_EDGE_FLOOR),
    x: seat.x,
    y: seat.y,
    radius: seat.radius,
    gain,
  };
}

/** Guests off, but seated and coloured like the key so a fade in or out never shifts hue. */
function soloLights(tone: BotCrestTone): StageLights {
  return {
    key: lampFrom(tone, LAMP_SEATS.key, 1),
    guestA: lampFrom(tone, LAMP_SEATS.guestA, 0),
    guestB: lampFrom(tone, LAMP_SEATS.guestB, 0),
  };
}

export function stageLightsFor(room: StageRoom | undefined): StageLights {
  if (!room || room.kind === 'lobby' || room.kind === 'direct') return soloLights(BRAND_TONE);
  if (room.kind === 'bot') return soloLights(botCrestFromId(room.botId, room.name).tone);
  const tones = room.memberIds.slice(0, 3).map((id) => botCrestFromId(id).tone);
  if (tones.length === 0) return soloLights(BRAND_TONE);
  const [first, second, third] = tones;
  return {
    key: lampFrom(first, LAMP_SEATS.roomKey, 1),
    guestA: lampFrom(second ?? first, LAMP_SEATS.guestA, second ? 0.95 : 0),
    guestB: lampFrom(third ?? second ?? first, LAMP_SEATS.guestB, third ? 0.85 : 0),
  };
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  'worklet';
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function mixLamp(a: StageLamp, b: StageLamp, t: number): StageLamp {
  'worklet';
  return {
    core: mixRgb(a.core, b.core, t),
    edge: mixRgb(a.edge, b.edge, t),
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    radius: a.radius + (b.radius - a.radius) * t,
    gain: a.gain + (b.gain - a.gain) * t,
  };
}

/** A room change is a crossfade in linear light: colour, seat, reach and strength together. */
export function mixLights(a: StageLights, b: StageLights, t: number): StageLights {
  'worklet';
  // Settled light is exactly the room's own, never a float's width away from it.
  if (t <= 0) return a;
  if (t >= 1) return b;
  return {
    key: mixLamp(a.key, b.key, t),
    guestA: mixLamp(a.guestA, b.guestA, t),
    guestB: mixLamp(a.guestB, b.guestB, t),
  };
}
