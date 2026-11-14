import type { BotLook } from '@/lib/avatar/look';

export type FigureMood = 'idle' | 'thinking';

export type FigureAnimationInput = {
  animated: boolean;
  animationActive: boolean;
  reducedMotion: boolean;
  size: number;
  mood: FigureMood;
  face: BotLook['face'];
};

export type FigureAnimationPlan = {
  live: boolean;
  blink: boolean;
  pulse: boolean;
  gaze: boolean;
  cycle: boolean;
};

/**
 * Which continuous tracks a figure needs. Identity and event-driven reactions
 * do not depend on this plan; hidden, small, or reduced-motion figures schedule
 * no worklets, and an idle face only keeps its sparse blink. The shared stage
 * lamp belongs to AmbientCanvas; per-figure pulse is reserved for thinking.
 */
export function figureAnimationPlan({
  animated,
  animationActive,
  reducedMotion,
  size,
  mood,
  face,
}: FigureAnimationInput): FigureAnimationPlan {
  const live = animated && animationActive && !reducedMotion && size >= 30;
  const thinking = live && mood === 'thinking';
  const blinks = ['calm', 'bright', 'visor', 'iris', 'pixel', 'starry'].includes(face);
  const usesGaze = !['monogram', 'visor', 'bare'].includes(face);
  const usesCycle = face === 'visor' || face === 'starry';

  return {
    live,
    blink: live && blinks,
    pulse: thinking,
    gaze: thinking && usesGaze,
    cycle: thinking && usesCycle,
  };
}
