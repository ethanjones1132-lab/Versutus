import { GOVERNOR, GOVERNOR_LEVELS, governorAdvance, initialGovernor } from '@/lib/stage/governor';

/** Feed clean frames until `untilMs`; returns the clock. */
function runClean(state: ReturnType<typeof initialGovernor>, from: number, untilMs: number, dt = 16) {
  let t = from;
  while (t < untilMs) {
    t += dt;
    governorAdvance(state, t, dt);
  }
  return t;
}

describe('stage governor', () => {
  test('the level table: 24 Hz at a quarter size, then 12 Hz, then a smaller field, then rest', () => {
    expect(GOVERNOR_LEVELS[0]).toEqual({ fieldHz: 24, scale: 0.25 });
    expect(GOVERNOR_LEVELS[1]).toEqual({ fieldHz: 12, scale: 0.25 });
    expect(GOVERNOR_LEVELS[2].fieldHz).toBe(12);
    expect(GOVERNOR_LEVELS[2].scale).toBeLessThan(0.25);
    expect(GOVERNOR_LEVELS[3].fieldHz).toBe(0);
  });

  test('clean frames never step down', () => {
    const s = initialGovernor();
    runClean(s, 0, 60_000);
    expect(s.level).toBe(0);
  });

  test('three drops inside the window step down one level', () => {
    const s = initialGovernor();
    expect(governorAdvance(s, 1000, 40)).toBe(false);
    expect(governorAdvance(s, 1020, 40)).toBe(false);
    expect(governorAdvance(s, 1040, 40)).toBe(true);
    expect(s.level).toBe(1);
    expect(s.drops).toBe(0);
  });

  test('drops spread across more than the window do not add up', () => {
    const s = initialGovernor();
    governorAdvance(s, 3000, 40);
    governorAdvance(s, 5600, 40);
    governorAdvance(s, 8200, 40);
    expect(s.level).toBe(0);
  });

  test('a long pause is not a drop: the app was in the background', () => {
    const s = initialGovernor();
    expect(governorAdvance(s, 10_000, GOVERNOR.pauseMs + 1)).toBe(false);
    governorAdvance(s, 10_020, 40);
    governorAdvance(s, 10_040, 40);
    expect(s.level).toBe(0);
  });

  test('it never goes below the last level or above the first', () => {
    const s = initialGovernor();
    let t = 1000;
    for (let i = 0; i < 30; i += 1) {
      t += 20;
      governorAdvance(s, t, 40);
    }
    expect(s.level).toBe(GOVERNOR_LEVELS.length - 1);
    runClean(s, t, t + 600_000);
    expect(s.level).toBe(0);
    runClean(s, t + 600_000, t + 700_000);
    expect(s.level).toBe(0);
  });

  test('it steps back up only after a clean stretch, and waits longer if it flaps', () => {
    const s = initialGovernor();
    let t = 1000;
    for (let i = 0; i < 3; i += 1) {
      t += 20;
      governorAdvance(s, t, 40);
    }
    expect(s.level).toBe(1);
    t = runClean(s, t, t + 19_000);
    expect(s.level).toBe(1);
    t = runClean(s, t, t + 2_000);
    expect(s.level).toBe(0);

    // trouble again right after stepping up: it steps down and now waits twice as long
    for (let i = 0; i < 3; i += 1) {
      t += 20;
      governorAdvance(s, t, 40);
    }
    expect(s.level).toBe(1);
    expect(s.upWaitMs).toBe(GOVERNOR.cleanMsToStepUp * 2);
    const downAt = t;
    t = runClean(s, t, downAt + 39_000);
    expect(s.level).toBe(1);
    runClean(s, t, downAt + 41_000);
    expect(s.level).toBe(0);
  });
});
