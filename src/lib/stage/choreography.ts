/**
 * How the lamp moves: every curve, gain and duration the stage renderers
 * share, and the one function that turns a moment into shader uniforms.
 *
 * Nocturne motion, applied to light:
 *  - The air in the light morphs in place, slower than the eye tracks.
 *    Nothing slides, nothing loops visibly, nothing bounces.
 *  - Light answers events and never announces a state: a sent message rises
 *    as a swell of light, a speaking Bot brightens the room a little, an
 *    offline Gate dims it. The caret, the dot and the count stay the signals.
 *  - Under Reduce Motion the air stands still, a room change is a short
 *    fade, and nothing rises.
 *
 * Pure and worklet-safe: the native renderer calls `stageUniforms` on the
 * UI thread every frame, the web renderer calls it from its frame loop.
 */

import type { ConnectionStatus } from '@/lib/gateway/types';

import { STAGE_BASE, type Rgb, type StageLamp, type StageLights } from './lamp';

export const STAGE_TIMING = {
  /** The first light of a session: the lamp warms up from a dark room. */
  lampOnMs: 2400,
  /** A room change: one colour gives way to the next. */
  tintMs: 1600,
  /** A room change under Reduce Motion. */
  reducedTintMs: 220,
  /** A sent message rising from the composer and fading into the air. */
  swellMs: 2100,
  /** Time constants for the light easing toward a new level. */
  speakRiseTau: 420,
  speakFallTau: 1500,
  connectionTau: 800,
  scrollTau: 240,
  /** With no touch and nothing happening, the air stills and the loop sleeps. */
  idleAfterMs: 40_000,
  /** Drift frame spacing: the air moves too slowly for more frames to show. */
  driftFrameMs: 1000 / 24,
} as const;

export const STAGE_GAIN = {
  /** A Bot speaking: the room is a little brighter, held while it talks. */
  speaking: 1.14,
  /** Reaching or pairing the Gate: the lamp waits at a lower level. */
  reaching: 0.72,
  /** The Gate is offline: the room goes dim — messages will wait. */
  offline: 0.34,
  /** How far the light dips mid-way through a room change. */
  tintDip: 0.2,
  /** The warm pool of light the composer rests in, relative to the key. */
  bounce: 0.14,
  /** The room's colour carried faintly across the whole stage. */
  ambient: 0.004,
  /** The crest of a sent-message swell. */
  swell: 0.62,
} as const;

/** The moment the still stage shows under Reduce Motion: a composed frame of air. */
export const STILL_TIME_SEC = 41.5;

function clamp01(value: number): number {
  'worklet';
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function easeInOutCubic(t: number): number {
  'worklet';
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function easeOutCubic(t: number): number {
  'worklet';
  const x = clamp01(t);
  return 1 - Math.pow(1 - x, 3);
}

/** Smootherstep — the lamp's warm-up: no snap at the start, no stop at the end. */
export function smootherstep(t: number): number {
  'worklet';
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** How far a room change has come, eased. */
export function tintBlend(elapsedMs: number, durationMs: number = STAGE_TIMING.tintMs): number {
  'worklet';
  if (durationMs <= 0) return 1;
  return easeInOutCubic(elapsedMs / durationMs);
}

/** The light breathes out and in as one room's colour gives way to the next. */
export function tintDipGain(blend: number): number {
  'worklet';
  return 1 - STAGE_GAIN.tintDip * Math.sin(Math.PI * clamp01(blend));
}

/** The session's first light. `null` means the lamp was already on. */
export function lampOnGain(elapsedMs: number | null): number {
  'worklet';
  if (elapsedMs === null) return 1;
  return smootherstep(elapsedMs / STAGE_TIMING.lampOnMs);
}

/** How brightly the lamp burns for the Gate's connection. */
export function connectionGain(status: ConnectionStatus | undefined): number {
  'worklet';
  if (status === undefined || status === 'connected') return 1;
  if (status === 'disconnected') return STAGE_GAIN.offline;
  return STAGE_GAIN.reaching;
}

/** Exponential approach: frame-rate independent easing toward a moving target. */
export function approach(current: number, target: number, dtMs: number, tauMs: number): number {
  'worklet';
  if (tauMs <= 0 || dtMs <= 0) return dtMs > 0 ? target : current;
  return current + (target - current) * (1 - Math.exp(-dtMs / tauMs));
}

/**
 * A sent message as light: a soft band that rises from just under the
 * composer to about the middle of the screen, spreading and fading as it goes
 * — quick to arrive, slow to leave. Returns the band's centre (width units,
 * y down), strength, and half-width; strength 0 when nothing is rising.
 */
export function swellUniform(elapsedMs: number | null, heightUnits: number): [number, number, number] {
  'worklet';
  if (elapsedMs === null || elapsedMs < 0 || elapsedMs >= STAGE_TIMING.swellMs) return [0, 0, 0.1];
  const p = elapsedMs / STAGE_TIMING.swellMs;
  const rise = easeOutCubic(p);
  const front = heightUnits * (1.04 - 0.56 * rise);
  const attack = smootherstep(p / 0.1);
  const amount = STAGE_GAIN.swell * attack * Math.pow(1 - p, 1.6);
  const halfWidth = 0.1 + 0.26 * rise;
  return [front, amount, halfWidth];
}

export type StageFrame = {
  /** Drawing surface, in the renderer's pixels. */
  width: number;
  height: number;
  /** Device pixels per surface pixel — the dither lands on real pixels. */
  pixelRatio: number;
  /** Stage time in seconds: advances only while the air may move. */
  timeSec: number;
  /** The lights, already mixed for any room change in flight. */
  lights: StageLights;
  /** Everything that scales the whole lamp: first light × connection × speaking × tint dip. */
  gain: number;
  /** Milliseconds since the last sent message, or null. */
  swellElapsedMs: number | null;
  /** Scroll parallax, −1…1. */
  scroll: number;
  /** Device tilt, −1…1 on each axis (0 where there is no sensor). */
  tiltX: number;
  tiltY: number;
};

export type StageUniforms = {
  uResolution: [number, number];
  uTime: number;
  uPixelRatio: number;
  uParallax: [number, number, number];
  uBase: [number, number, number];
  uKeyCore: [number, number, number];
  uKeyEdge: [number, number, number];
  uKeySeat: [number, number, number, number];
  uGuestACore: [number, number, number];
  uGuestAEdge: [number, number, number];
  uGuestASeat: [number, number, number, number];
  uGuestBCore: [number, number, number];
  uGuestBEdge: [number, number, number];
  uGuestBSeat: [number, number, number, number];
  uFill: [number, number];
  uSwell: [number, number, number];
};

function rgb3(color: Rgb): [number, number, number] {
  'worklet';
  return [color[0], color[1], color[2]];
}

function seat(lamp: StageLamp, gain: number): [number, number, number, number] {
  'worklet';
  return [lamp.x, lamp.y, lamp.radius, lamp.gain * gain];
}

/** One moment of the stage, as the shader's uniforms. */
export function stageUniforms(frame: StageFrame): StageUniforms {
  'worklet';
  const width = Math.max(1, frame.width);
  const height = Math.max(1, frame.height);
  const { key, guestA, guestB } = frame.lights;
  return {
    uResolution: [width, height],
    uTime: frame.timeSec,
    uPixelRatio: frame.pixelRatio,
    uParallax: [frame.scroll, frame.tiltX, frame.tiltY],
    uBase: rgb3(STAGE_BASE),
    uKeyCore: rgb3(key.core),
    uKeyEdge: rgb3(key.edge),
    uKeySeat: seat(key, frame.gain),
    uGuestACore: rgb3(guestA.core),
    uGuestAEdge: rgb3(guestA.edge),
    uGuestASeat: seat(guestA, frame.gain),
    uGuestBCore: rgb3(guestB.core),
    uGuestBEdge: rgb3(guestB.edge),
    uGuestBSeat: seat(guestB, frame.gain),
    uFill: [STAGE_GAIN.bounce * frame.gain, STAGE_GAIN.ambient * Math.min(1, frame.gain)],
    uSwell: swellUniform(frame.swellElapsedMs, height / width),
  };
}
