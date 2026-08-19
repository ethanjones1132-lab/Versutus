import { mapAmbientParallax } from '@/lib/motion/ambient-parallax';

describe('mapAmbientParallax', () => {
  test('rest at 0', () => {
    expect(mapAmbientParallax(0)).toEqual({ parallaxX: 0, parallaxY: 0 });
  });

  test('480px maps to +1 and -480px maps to -1', () => {
    expect(mapAmbientParallax(480)).toEqual({ parallaxX: 0, parallaxY: 1 });
    expect(mapAmbientParallax(-480)).toEqual({ parallaxX: 0, parallaxY: -1 });
  });

  test('clamps extreme scroll and treats non-finite as rest', () => {
    expect(mapAmbientParallax(10_000)).toEqual({ parallaxX: 0, parallaxY: 1 });
    expect(mapAmbientParallax(-10_000)).toEqual({ parallaxX: 0, parallaxY: -1 });
    expect(mapAmbientParallax(Number.NaN)).toEqual({ parallaxX: 0, parallaxY: 0 });
    expect(mapAmbientParallax(Number.POSITIVE_INFINITY)).toEqual({ parallaxX: 0, parallaxY: 0 });
  });

  test('parallaxX is always 0 this phase', () => {
    expect(mapAmbientParallax(240).parallaxX).toBe(0);
    expect(mapAmbientParallax(240).parallaxY).toBeCloseTo(0.5);
  });
});
