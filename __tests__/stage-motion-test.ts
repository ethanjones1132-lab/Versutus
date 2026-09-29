import {
  STAGE_GAIN,
  STAGE_TIMING,
  STILL_TIME_SEC,
  approach,
  connectionGain,
  easeInOutCubic,
  lampOnGain,
  stageUniforms,
  swellUniform,
  tintBlend,
  tintDipGain,
} from '@/lib/stage/choreography';
import { stageLightsFor } from '@/lib/stage/lamp';
import { StageMotion } from '@/lib/stage/motion';
import { STAGE_UNIFORM_LAYOUT } from '@/lib/stage/shader';
import {
  getStageSignals,
  resetStageSignals,
  signalConnection,
  signalSent,
  signalSpeaking,
  signalTouched,
  subscribeStageSignals,
  type StageSignalState,
} from '@/lib/stage/signals';

const SURFACE = { width: 430, height: 932, pixelRatio: 1 };
const LOBBY = stageLightsFor({ kind: 'lobby' });
const FORGE = stageLightsFor({ kind: 'bot', botId: 'forge' });
const QUIET: StageSignalState = { sendCount: 0, speaking: false, connection: 'connected', touchedAt: 0 };

beforeEach(() => resetStageSignals());

/** Run a stage forward in fixed frames; returns the last step. */
function run(motion: StageMotion, fromMs: number, toMs: number, signals: StageSignalState = QUIET, idle = false) {
  let step = motion.step(fromMs, 16, signals, SURFACE, idle);
  for (let now = fromMs + 16; now <= toMs; now += 16) step = motion.step(now, 16, signals, SURFACE, idle);
  return step;
}

describe('choreography curves', () => {
  test('eases start at rest and end at rest', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 9);
    expect(tintBlend(-50)).toBe(0);
    expect(tintBlend(STAGE_TIMING.tintMs * 2)).toBe(1);
  });

  test('the light breathes out mid-change and is whole at both ends', () => {
    expect(tintDipGain(0)).toBe(1);
    expect(tintDipGain(1)).toBeCloseTo(1, 12);
    expect(tintDipGain(0.5)).toBeCloseTo(1 - STAGE_GAIN.tintDip, 9);
  });

  test('the first light warms up from dark; a lit lamp stays lit', () => {
    expect(lampOnGain(0)).toBe(0);
    expect(lampOnGain(STAGE_TIMING.lampOnMs / 2)).toBeCloseTo(0.5, 9);
    expect(lampOnGain(STAGE_TIMING.lampOnMs)).toBe(1);
    expect(lampOnGain(null)).toBe(1);
  });

  test('the Gate’s connection sets how brightly the lamp burns — no Gate is not an outage', () => {
    expect(connectionGain('connected')).toBe(1);
    expect(connectionGain(undefined)).toBe(1);
    expect(connectionGain('connecting')).toBe(STAGE_GAIN.reaching);
    expect(connectionGain('reconnecting')).toBe(STAGE_GAIN.reaching);
    expect(connectionGain('pairing')).toBe(STAGE_GAIN.reaching);
    expect(connectionGain('disconnected')).toBe(STAGE_GAIN.offline);
    expect(STAGE_GAIN.offline).toBeLessThan(STAGE_GAIN.reaching);
  });

  test('easing toward a level is independent of the frame rate', () => {
    const oneStep = approach(1, 2, 32, 400);
    const twoSteps = approach(approach(1, 2, 16, 400), 2, 16, 400);
    expect(twoSteps).toBeCloseTo(oneStep, 12);
    expect(approach(1, 2, 10_000, 400)).toBeCloseTo(2, 6);
  });

  test('a sent message rises from under the composer, spreads, and is gone by the end', () => {
    const H = 932 / 430;
    expect(swellUniform(null, H)[1]).toBe(0);
    expect(swellUniform(STAGE_TIMING.swellMs, H)[1]).toBe(0);
    const early = swellUniform(STAGE_TIMING.swellMs * 0.2, H);
    const late = swellUniform(STAGE_TIMING.swellMs * 0.8, H);
    expect(early[0]).toBeGreaterThan(late[0]); // it rises (y is down)
    expect(early[0]).toBeLessThan(H * 1.05);
    expect(late[0]).toBeGreaterThan(H * 0.4); // it never climbs past the middle of the screen
    expect(early[1]).toBeGreaterThan(late[1]); // it fades as it goes
    expect(late[2]).toBeGreaterThan(early[2]); // and spreads
    expect(swellUniform(STAGE_TIMING.swellMs * 0.999, H)[1]).toBeLessThan(0.001);
  });

  test('uniforms cover exactly the shader’s declared layout', () => {
    const uniforms = stageUniforms({
      ...SURFACE,
      timeSec: 1,
      lights: LOBBY,
      gain: 0.5,
      swellElapsedMs: null,
      scroll: 0,
      tiltX: 0,
      tiltY: 0,
    });
    expect(Object.keys(uniforms).sort()).toEqual(STAGE_UNIFORM_LAYOUT.map(([name]) => name).sort());
    for (const [name, size] of STAGE_UNIFORM_LAYOUT) {
      const value = uniforms[name];
      expect(size === 1 ? typeof value : (value as number[]).length).toBe(size === 1 ? 'number' : size);
    }
    expect(uniforms.uKeySeat[3]).toBeCloseTo(LOBBY.key.gain * 0.5, 12);
  });
});

describe('a stage over time', () => {
  test('the session’s first light rises from dark; later stages open lit', () => {
    const first = new StageMotion({ lights: LOBBY, now: 0, firstLight: true, reducedMotion: false });
    expect(first.step(0, 16, QUIET, SURFACE, false).uniforms.uKeySeat[3]).toBeCloseTo(0, 6);
    expect(run(first, 16, STAGE_TIMING.lampOnMs + 32).uniforms.uKeySeat[3]).toBeCloseTo(1, 6);
    const later = new StageMotion({ lights: LOBBY, now: 0, firstLight: false, reducedMotion: false });
    expect(later.step(0, 16, QUIET, SURFACE, false).uniforms.uKeySeat[3]).toBeCloseTo(1, 6);
  });

  test('entering a Bot’s thread crossfades the room, dipping mid-way, then settles', () => {
    const motion = new StageMotion({ lights: LOBBY, now: 0, firstLight: false, reducedMotion: false });
    run(motion, 0, 100);
    motion.setRoom(FORGE, 100);
    const mid = motion.step(100 + STAGE_TIMING.tintMs / 2, 16, QUIET, SURFACE, false);
    expect(mid.animating).toBe(true);
    expect(mid.uniforms.uKeySeat[3]).toBeCloseTo(1 - STAGE_GAIN.tintDip, 6);
    const settled = run(motion, 100 + STAGE_TIMING.tintMs / 2, 100 + STAGE_TIMING.tintMs + 64);
    expect(settled.uniforms.uKeyEdge).toEqual([...FORGE.key.edge]);
    expect(settled.uniforms.uKeySeat[3]).toBeCloseTo(1, 9);
  });

  test('a room change mid-change starts from the light as it is, not where it began', () => {
    const motion = new StageMotion({ lights: LOBBY, now: 0, firstLight: false, reducedMotion: false });
    motion.setRoom(FORGE, 0);
    const halfway = motion.lightsAt(STAGE_TIMING.tintMs / 2);
    motion.setRoom(LOBBY, STAGE_TIMING.tintMs / 2);
    expect(motion.lightsAt(STAGE_TIMING.tintMs / 2)).toEqual(halfway);
  });

  test('a send rises once; sends from before the stage mounted, or while it was hidden, do not', () => {
    const motion = new StageMotion({ lights: LOBBY, now: 0, firstLight: false, reducedMotion: false });
    const before = { ...QUIET, sendCount: 3 };
    expect(motion.step(0, 16, before, SURFACE, false).uniforms.uSwell[1]).toBe(0);
    const sent = { ...QUIET, sendCount: 4 };
    motion.step(16, 16, sent, SURFACE, false);
    expect(motion.step(16 + STAGE_TIMING.swellMs * 0.3, 16, sent, SURFACE, false).uniforms.uSwell[1]).toBeGreaterThan(0.1);
    const done = run(motion, 16 + STAGE_TIMING.swellMs * 0.3, 16 + STAGE_TIMING.swellMs + 32, sent);
    expect(done.uniforms.uSwell[1]).toBe(0);
    // Hidden while two more messages went out: on return it catches up quietly.
    motion.resync({ ...QUIET, sendCount: 6 });
    expect(motion.step(5000, 16, { ...QUIET, sendCount: 6 }, SURFACE, false).uniforms.uSwell[1]).toBe(0);
  });

  test('a speaking Bot brightens the room while it talks, and the room settles after', () => {
    const motion = new StageMotion({ lights: LOBBY, now: 0, firstLight: false, reducedMotion: false });
    const talking = run(motion, 0, 3000, { ...QUIET, speaking: true });
    expect(talking.uniforms.uKeySeat[3]).toBeCloseTo(STAGE_GAIN.speaking, 3);
    const after = run(motion, 3016, 15_000, QUIET);
    expect(after.uniforms.uKeySeat[3]).toBeCloseTo(1, 3);
    expect(after.animating).toBe(false);
  });

  test('an offline Gate dims every lamp in the room', () => {
    const motion = new StageMotion({ lights: LOBBY, now: 0, firstLight: false, reducedMotion: false });
    const dim = run(motion, 0, 8000, { ...QUIET, connection: 'disconnected' });
    expect(dim.uniforms.uKeySeat[3]).toBeCloseTo(STAGE_GAIN.offline, 3);
    expect(dim.uniforms.uFill[0]).toBeCloseTo(STAGE_GAIN.bounce * STAGE_GAIN.offline, 3);
  });

  test('the air moves only while someone is here; idle, it stills and the stage stops asking for frames', () => {
    const motion = new StageMotion({ lights: LOBBY, now: 0, firstLight: false, reducedMotion: false });
    const moving = run(motion, 0, 1000);
    expect(moving.drifting).toBe(true);
    expect(moving.uniforms.uTime).toBeGreaterThan(STILL_TIME_SEC);
    const stilled = motion.step(1016, 16, QUIET, SURFACE, true);
    const again = motion.step(3016, 2000, QUIET, SURFACE, true);
    expect(again.uniforms.uTime).toBe(stilled.uniforms.uTime);
    expect(again.drifting || again.animating).toBe(false);
  });

  test('under Reduce Motion the air stands still, a room change is a short fade, and nothing rises', () => {
    const motion = new StageMotion({ lights: LOBBY, now: 0, firstLight: true, reducedMotion: true });
    const first = motion.step(0, 16, QUIET, SURFACE, false);
    expect(first.uniforms.uKeySeat[3]).toBeCloseTo(1, 6); // no warm-up either
    expect(first.uniforms.uTime).toBe(STILL_TIME_SEC);
    expect(first.drifting).toBe(false);
    motion.setRoom(FORGE, 100);
    expect(motion.step(100 + STAGE_TIMING.reducedTintMs + 16, 16, QUIET, SURFACE, false).uniforms.uKeyEdge).toEqual([...FORGE.key.edge]);
    motion.step(400, 16, { ...QUIET, sendCount: 1 }, SURFACE, false);
    expect(motion.step(600, 16, { ...QUIET, sendCount: 1 }, SURFACE, false).uniforms.uSwell[1]).toBe(0);
  });

  test('scroll parallax eases toward the list and clamps to the stage’s range', () => {
    const motion = new StageMotion({ lights: LOBBY, now: 0, firstLight: false, reducedMotion: false });
    motion.setScroll(5);
    expect(run(motion, 0, 3000).uniforms.uParallax[0]).toBeCloseTo(1, 3);
    motion.setScroll(Number.NaN);
    expect(run(motion, 3016, 6000).uniforms.uParallax[0]).toBeCloseTo(0, 3);
  });
});

describe('stage signals', () => {
  test('sends count up, speaking and connection are levels, and listeners hear only real changes', () => {
    const heard: StageSignalState[] = [];
    const unsubscribe = subscribeStageSignals(() => heard.push(getStageSignals()));
    signalSent();
    signalSent();
    signalSpeaking(true);
    signalSpeaking(true);
    signalConnection('disconnected');
    unsubscribe();
    signalSpeaking(false);
    expect(heard.map((s) => [s.sendCount, s.speaking, s.connection])).toEqual([
      [1, false, undefined],
      [2, false, undefined],
      [2, true, undefined],
      [2, true, 'disconnected'],
    ]);
  });

  test('touch is throttled to once a second — the stage only needs to know someone is here', () => {
    const heard: number[] = [];
    const unsubscribe = subscribeStageSignals(() => heard.push(getStageSignals().touchedAt));
    signalTouched(10_000);
    signalTouched(10_400);
    signalTouched(11_200);
    unsubscribe();
    expect(heard).toEqual([10_000, 11_200]);
  });
});
