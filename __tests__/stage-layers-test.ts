import { STAGE_GAIN } from '@/lib/stage/choreography';
import { STAGE_BASE } from '@/lib/stage/lamp';
import {
  FIELD_GAIN,
  LAYER_TIMING,
  SWELL_PEAK,
  TOOL_BREATH,
  breathGain,
  lightCss,
  stageBaseCss,
  swellOpacity,
  swellRise,
  swellScale,
  veilOpacity,
} from '@/lib/stage/layers';

describe('the veil', () => {
  test('the field renders at its speaking level, so the room at rest is mostly lit', () => {
    expect(FIELD_GAIN).toBe(STAGE_GAIN.speaking);
    expect(veilOpacity(1)).toBeCloseTo(0.1228, 3);
  });

  test('speaking is the veil fully open; the call peak cannot go brighter', () => {
    expect(veilOpacity(STAGE_GAIN.speaking)).toBe(0);
    expect(veilOpacity(2)).toBe(0);
  });

  test('the Gate levels land where the draft says', () => {
    expect(veilOpacity(STAGE_GAIN.reaching)).toBeCloseTo(0.368, 3);
    expect(veilOpacity(STAGE_GAIN.offline)).toBeCloseTo(0.702, 3);
  });

  test('a lamp that is off is a closed veil', () => {
    expect(veilOpacity(0)).toBe(1);
    expect(veilOpacity(-1)).toBe(1);
  });
});

describe('the tool breath', () => {
  test('swings five percent either side of the room', () => {
    expect(TOOL_BREATH).toBe(0.05);
    expect(breathGain(0)).toBeCloseTo(0.95, 9);
    expect(breathGain(0.5)).toBeCloseTo(1, 9);
    expect(breathGain(1)).toBeCloseTo(1.05, 9);
  });

  test('as veil opacity it is plus or minus about 0.044', () => {
    expect(veilOpacity(breathGain(0)) - veilOpacity(1)).toBeCloseTo(0.0439, 3);
    expect(veilOpacity(1) - veilOpacity(breathGain(1))).toBeCloseTo(0.0439, 3);
  });
});

describe('the swell layer', () => {
  test('is shorter than the old shader swell and silent outside its run', () => {
    expect(LAYER_TIMING.swellMs).toBe(1100);
    expect(swellOpacity(null)).toBe(0);
    expect(swellOpacity(-5)).toBe(0);
    expect(swellOpacity(LAYER_TIMING.swellMs)).toBe(0);
  });

  test('attacks quickly, then fades slowly', () => {
    const peakish = swellOpacity(LAYER_TIMING.swellMs * 0.1);
    expect(peakish).toBeGreaterThan(SWELL_PEAK * 0.8);
    expect(peakish).toBeLessThanOrEqual(SWELL_PEAK);
    expect(swellOpacity(LAYER_TIMING.swellMs * 0.5)).toBeLessThan(peakish);
    expect(swellOpacity(LAYER_TIMING.swellMs * 0.95)).toBeLessThan(0.05);
  });

  test('rises with an ease-out and grows from 0.6 to 1.6', () => {
    expect(swellRise(null)).toBe(1);
    expect(swellRise(0)).toBe(0);
    expect(swellRise(LAYER_TIMING.swellMs)).toBe(1);
    expect(swellRise(LAYER_TIMING.swellMs * 0.5)).toBeGreaterThan(0.5);
    expect(swellScale(0)).toBeCloseTo(0.6, 9);
    expect(swellScale(1)).toBeCloseTo(1.6, 9);
  });
});

describe('colour helpers', () => {
  test('the stage base as css', () => {
    expect(stageBaseCss()).toMatch(/^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/);
    expect(stageBaseCss()).toBe(stageBaseCss());
    expect(STAGE_BASE.length).toBe(3);
  });

  test('a light as css keeps its alpha and clamps to a valid channel', () => {
    expect(lightCss([0.02, 0.2, 0.3], 0.5)).toMatch(/^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, 0\.5\)$/);
    expect(lightCss([9, 9, 9], 1)).toBe('rgba(255, 255, 255, 1)');
    expect(lightCss([0, 0, 0], 0)).toBe('rgba(0, 0, 0, 0)');
  });
});
