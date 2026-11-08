/**
 * Reactions that live on cheap layers above the lamp field instead of inside
 * its shader. Brightness is the Veil: the field renders at its speaking level
 * and a dark layer over it carries every brightness change as one alpha value,
 * so speaking, a tool's breath, the Gate's dimming and the first light never
 * redraw the field. The send swell is a soft gradient circle that rises and
 * fades, drawn once. Spec: docs/superpowers/specs/2026-11-07-ambient-redesign-design.md
 * section 3; motion draft sections 2.2 and 4.
 *
 * Pure and worklet-safe (the UI thread calls these every frame).
 */

import { STAGE_GAIN, easeOutCubic, smootherstep } from './choreography';
import { STAGE_BASE, linearToSrgb, type Rgb } from './lamp';

/** The brightness the field is rendered at. The Veil only ever darkens it. */
export const FIELD_GAIN = STAGE_GAIN.speaking;

export const LAYER_TIMING = {
  /** The send swell as a layer: shorter than the shader swell it replaces. */
  swellMs: 1100,
  /** One full breath of the shared clock. */
  breathMs: 2400,
} as const;

/** How far a tool's breath swings the room either side of its resting level. */
export const TOOL_BREATH = 0.05;
export const SWELL_PEAK = 0.5;

/** Veil opacity for a room brightness (1 = the lamp at rest). */
export function veilOpacity(gain: number): number {
  'worklet';
  const g = gain < 0 ? 0 : gain > FIELD_GAIN ? FIELD_GAIN : gain;
  return 1 - g / FIELD_GAIN;
}

/** The breath clock (0..1, eased) as a room-brightness multiplier. */
export function breathGain(breath: number): number {
  'worklet';
  return 1 + TOOL_BREATH * (2 * breath - 1);
}

/** The swell's strength. `null` means nothing is rising. */
export function swellOpacity(elapsedMs: number | null): number {
  'worklet';
  if (elapsedMs === null || elapsedMs < 0 || elapsedMs >= LAYER_TIMING.swellMs) return 0;
  const p = elapsedMs / LAYER_TIMING.swellMs;
  return SWELL_PEAK * smootherstep(p / 0.1) * Math.pow(1 - p, 1.6);
}

/** How far up the swell has travelled, 0..1 (1 when it is not running). */
export function swellRise(elapsedMs: number | null): number {
  'worklet';
  if (elapsedMs === null || elapsedMs >= LAYER_TIMING.swellMs) return 1;
  if (elapsedMs <= 0) return 0;
  return easeOutCubic(elapsedMs / LAYER_TIMING.swellMs);
}

/** The swell spreads as it rises. */
export function swellScale(rise: number): number {
  'worklet';
  return 0.6 + rise;
}

function channel(linear: number): number {
  const v = linearToSrgb(linear < 0 ? 0 : linear > 1 ? 1 : linear);
  return Math.round(v * 255);
}

/** The shader's base colour, for the Veil to darken toward. */
export function stageBaseCss(): string {
  return `rgb(${channel(STAGE_BASE[0])}, ${channel(STAGE_BASE[1])}, ${channel(STAGE_BASE[2])})`;
}

/** A lamp's core as a visible css colour (lamp light is dim by design, so it is lifted to be seen). */
export function lightCss(core: Rgb, alpha: number): string {
  return `rgba(${channel(core[0] * 3)}, ${channel(core[1] * 3)}, ${channel(core[2] * 3)}, ${alpha})`;
}
