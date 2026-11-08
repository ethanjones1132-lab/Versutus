import {
  STAGE_OVERSIZE_DP,
  STAGE_RENDER_SCALE,
  oversizedBox,
  scaledCanvasSize,
  upscaleFactor,
} from '@/lib/stage/render-scale';

describe('stage render scale', () => {
  test('the shipped scale is a quarter', () => {
    expect(STAGE_RENDER_SCALE).toBe(0.25);
  });

  test('a canvas is the box times the scale, rounded, never under one pixel', () => {
    expect(scaledCanvasSize({ width: 411.4, height: 890.2 }, 0.5)).toEqual({ width: 206, height: 445 });
    expect(scaledCanvasSize({ width: 1, height: 1 }, 0.25)).toEqual({ width: 1, height: 1 });
  });

  test('a nonsense scale means full size', () => {
    expect(scaledCanvasSize({ width: 100, height: 200 }, 0)).toEqual({ width: 100, height: 200 });
    expect(scaledCanvasSize({ width: 100, height: 200 }, 3)).toEqual({ width: 100, height: 200 });
    expect(scaledCanvasSize({ width: 100, height: 200 }, Number.NaN)).toEqual({ width: 100, height: 200 });
  });

  test('scaling the canvas back up always covers the box', () => {
    for (const box of [
      { width: 411.4, height: 890.2 },
      { width: 360, height: 780 },
      { width: 393.7, height: 851.3 },
    ]) {
      for (const scale of [0.5, 0.33, 0.25]) {
        const canvas = scaledCanvasSize(box, scale);
        const factor = upscaleFactor(box, canvas);
        expect(canvas.width * factor).toBeGreaterThanOrEqual(box.width - 1e-9);
        expect(canvas.height * factor).toBeGreaterThanOrEqual(box.height - 1e-9);
      }
    }
  });

  test('the field is drawn a little oversize so it can move by transform', () => {
    expect(STAGE_OVERSIZE_DP).toBe(12);
    expect(oversizedBox({ width: 400, height: 800 })).toEqual({ width: 424, height: 824 });
  });
});
