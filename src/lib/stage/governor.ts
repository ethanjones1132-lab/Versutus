/**
 * The lamp's safety valve. It watches the UI thread's frame gaps and steps the
 * lamp down when the phone cannot keep up: 24 draws a second, then 12, then a
 * smaller field, then rest. It steps back up only after a long clean stretch,
 * and waits longer each time it flaps. The thresholds are starting guesses:
 * tune them on the A54 (docs/perf/README.md).
 *
 * Pure and worklet-safe: `governorAdvance` runs on the UI thread every frame
 * and mutates its state in place, so a frame allocates nothing.
 */

import { STAGE_RENDER_SCALE } from './render-scale';

export const GOVERNOR = {
  /** A frame gap at or over this is a dropped frame (about two frames at 60 Hz). */
  dropFrameMs: 25,
  /** A gap over this is a pause (backgrounded, screen off), not a drop. */
  pauseMs: 1000,
  /** Drops are counted inside a window this long. */
  windowMs: 2000,
  dropsToStepDown: 3,
  /** Clean time before stepping back up. */
  cleanMsToStepUp: 20_000,
  /** Stepping down within this of stepping up doubles the next wait. */
  flapWindowMs: 60_000,
  maxUpWaitMs: 120_000,
} as const;

/**
 * Index = level. The scale is the fraction of screen resolution the field renders at: the default
 * (a quarter), then smaller still on the "smaller field" rung.
 */
export const GOVERNOR_LEVELS = [
  { fieldHz: 24, scale: STAGE_RENDER_SCALE },
  { fieldHz: 12, scale: STAGE_RENDER_SCALE },
  { fieldHz: 12, scale: 0.2 },
  { fieldHz: 0, scale: 0.2 },
] as const;

export type GovernorState = {
  level: number;
  windowStart: number;
  drops: number;
  cleanSince: number;
  upWaitMs: number;
  lastUpAt: number;
};

export function initialGovernor(level = 0): GovernorState {
  return {
    level,
    windowStart: 0,
    drops: 0,
    cleanSince: 0,
    upWaitMs: GOVERNOR.cleanMsToStepUp,
    lastUpAt: -1e9,
  };
}

/** Feed one frame. Returns true when the level changed. */
export function governorAdvance(state: GovernorState, nowMs: number, frameDeltaMs: number): boolean {
  'worklet';
  if (frameDeltaMs > GOVERNOR.pauseMs) {
    state.cleanSince = nowMs;
    state.windowStart = nowMs;
    state.drops = 0;
    return false;
  }
  if (nowMs - state.windowStart > GOVERNOR.windowMs) {
    state.windowStart = nowMs;
    state.drops = 0;
  }
  if (frameDeltaMs >= GOVERNOR.dropFrameMs) {
    state.drops += 1;
    state.cleanSince = nowMs;
    if (state.drops >= GOVERNOR.dropsToStepDown && state.level < GOVERNOR_LEVELS.length - 1) {
      if (nowMs - state.lastUpAt < GOVERNOR.flapWindowMs) {
        state.upWaitMs = Math.min(state.upWaitMs * 2, GOVERNOR.maxUpWaitMs);
      }
      state.level += 1;
      state.drops = 0;
      state.windowStart = nowMs;
      return true;
    }
    return false;
  }
  if (state.level > 0 && nowMs - state.cleanSince >= state.upWaitMs) {
    state.level -= 1;
    state.cleanSince = nowMs;
    state.lastUpAt = nowMs;
    return true;
  }
  return false;
}
