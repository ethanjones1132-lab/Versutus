import { figureAnimationPlan } from '@/lib/avatar/figure-motion';

describe('Bot figure motion budget', () => {
  const activeIdle = {
    animated: true,
    animationActive: true,
    reducedMotion: false,
    size: 44,
    mood: 'idle' as const,
  };

  test('an active idle figure keeps only its sparse blink; the shared lamp stays out of the figure', () => {
    expect(figureAnimationPlan({ ...activeIdle, face: 'bright' })).toEqual({
      live: true,
      blink: true,
      pulse: false,
      gaze: false,
      cycle: false,
    });
  });

  test('thinking enables gaze and only gives a scanner or starry face its cycle', () => {
    expect(figureAnimationPlan({ ...activeIdle, mood: 'thinking', face: 'visor' })).toEqual({
      live: true,
      blink: true,
      pulse: true,
      gaze: false,
      cycle: true,
    });
    expect(figureAnimationPlan({ ...activeIdle, mood: 'thinking', face: 'starry' })).toEqual({
      live: true,
      blink: true,
      pulse: true,
      gaze: true,
      cycle: true,
    });
    expect(figureAnimationPlan({ ...activeIdle, mood: 'thinking', face: 'bright' })).toEqual({
      live: true,
      blink: true,
      pulse: true,
      gaze: true,
      cycle: false,
    });
  });

  test('faces without lids or eyes schedule no invisible tracks', () => {
    expect(figureAnimationPlan({ ...activeIdle, face: 'bare' })).toEqual({
      live: true,
      blink: false,
      pulse: false,
      gaze: false,
      cycle: false,
    });
    expect(figureAnimationPlan({ ...activeIdle, mood: 'thinking', face: 'monogram' })).toEqual({
      live: true,
      blink: false,
      pulse: true,
      gaze: false,
      cycle: false,
    });
  });

  test.each([
    ['route is unfocused', { animationActive: false }],
    ['the app is backgrounded', { animationActive: false }],
    ['reduced motion is enabled', { reducedMotion: true }],
    ['the figure is below the animation size', { size: 29 }],
    ['animation is disabled by the caller', { animated: false }],
  ])('%s stops every continuous track', (_name, overrides) => {
    expect(figureAnimationPlan({ ...activeIdle, face: 'starry', mood: 'thinking', ...overrides })).toEqual({
      live: false,
      blink: false,
      pulse: false,
      gaze: false,
      cycle: false,
    });
  });
});
