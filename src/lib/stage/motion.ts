/**
 * One stage's light over time: the room it is in, the room it is leaving,
 * the air's clock, and the levels that ease toward what the signals ask.
 *
 * The web renderer owns one per mounted stage and calls `step` from its frame
 * loop; the native renderer runs the same curves (from ./choreography) on
 * Reanimated shared values. Pure — the caller supplies every clock reading.
 */

import {
  STAGE_GAIN,
  STAGE_TIMING,
  STILL_TIME_SEC,
  approach,
  connectionGain,
  lampOnGain,
  stageUniforms,
  tintBlend,
  tintDipGain,
  type StageUniforms,
} from './choreography';
import { mixLights, type StageLights } from './lamp';
import type { StageSignalState } from './signals';

export type StageSurface = { width: number; height: number; pixelRatio: number };

export type StageStep = {
  uniforms: StageUniforms;
  /** The air is moving: worth a frame at the drift rate. */
  drifting: boolean;
  /** Something is changing that deserves every frame: a room change, a swell, a level easing. */
  animating: boolean;
};

const SETTLED = 0.0015;

export class StageMotion {
  private from: StageLights;
  private to: StageLights;
  private tintStart = Number.NEGATIVE_INFINITY;
  private tintMs: number = STAGE_TIMING.tintMs;
  private time = STILL_TIME_SEC;
  private lampOnStart: number | null;
  private speaking = 1;
  private connection = 1;
  private scroll = 0;
  private scrollTarget = 0;
  private swellStart: number | null = null;
  private sendCount: number | null = null;
  private reduced: boolean;

  constructor(options: { lights: StageLights; now: number; firstLight: boolean; reducedMotion: boolean }) {
    this.from = options.lights;
    this.to = options.lights;
    this.reduced = options.reducedMotion;
    this.lampOnStart = options.firstLight && !options.reducedMotion ? options.now : null;
  }

  /** Move to another room: the light crossfades from wherever it is now. */
  setRoom(lights: StageLights, now: number): void {
    this.from = this.lightsAt(now);
    this.to = lights;
    this.tintStart = now;
    this.tintMs = this.reduced ? STAGE_TIMING.reducedTintMs : STAGE_TIMING.tintMs;
  }

  setScroll(value: number): void {
    this.scrollTarget = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  }

  setReducedMotion(reduced: boolean): void {
    this.reduced = reduced;
    if (reduced) {
      this.lampOnStart = null;
      this.swellStart = null;
    }
  }

  /**
   * Catch up with signals that changed while this stage was hidden, without
   * acting on them: a message sent on another screen does not rise here.
   */
  resync(signals: StageSignalState): void {
    this.sendCount = signals.sendCount;
    this.swellStart = null;
  }

  /** The lights at a moment, mid-crossfade or settled. */
  lightsAt(now: number): StageLights {
    return mixLights(this.from, this.to, tintBlend(now - this.tintStart, this.tintMs));
  }

  step(now: number, dtMs: number, signals: StageSignalState, surface: StageSurface, idle: boolean): StageStep {
    // A send the stage saw happen rises; sends from before it mounted do not.
    if (this.sendCount === null) {
      this.sendCount = signals.sendCount;
    } else if (signals.sendCount !== this.sendCount) {
      this.sendCount = signals.sendCount;
      if (!this.reduced) this.swellStart = now;
    }

    const speakTarget = signals.speaking ? STAGE_GAIN.speaking : 1;
    this.speaking = approach(
      this.speaking,
      speakTarget,
      dtMs,
      speakTarget > this.speaking ? STAGE_TIMING.speakRiseTau : STAGE_TIMING.speakFallTau,
    );
    const connectionTarget = connectionGain(signals.connection);
    this.connection = approach(this.connection, connectionTarget, dtMs, STAGE_TIMING.connectionTau);
    this.scroll = approach(this.scroll, this.scrollTarget, dtMs, STAGE_TIMING.scrollTau);

    const drifting = !this.reduced && !idle;
    if (drifting) this.time += dtMs / 1000;
    if (this.reduced) this.time = STILL_TIME_SEC;

    const blend = tintBlend(now - this.tintStart, this.tintMs);
    const lampOn = this.lampOnStart === null ? 1 : lampOnGain(now - this.lampOnStart);
    if (this.lampOnStart !== null && now - this.lampOnStart >= STAGE_TIMING.lampOnMs) this.lampOnStart = null;
    const swellElapsed = this.swellStart === null ? null : now - this.swellStart;
    if (swellElapsed !== null && swellElapsed >= STAGE_TIMING.swellMs) this.swellStart = null;

    const animating =
      blend < 1 ||
      lampOn < 1 ||
      this.swellStart !== null ||
      Math.abs(this.speaking - speakTarget) > SETTLED ||
      Math.abs(this.connection - connectionTarget) > SETTLED ||
      Math.abs(this.scroll - this.scrollTarget) > SETTLED;

    const uniforms = stageUniforms({
      width: surface.width,
      height: surface.height,
      pixelRatio: surface.pixelRatio,
      timeSec: this.time,
      lights: mixLights(this.from, this.to, blend),
      gain: lampOn * this.connection * this.speaking * tintDipGain(blend),
      swellElapsedMs: this.swellStart === null ? null : swellElapsed,
      scroll: this.scroll,
      tiltX: 0,
      tiltY: 0,
    });
    return { uniforms, drifting, animating };
  }
}
