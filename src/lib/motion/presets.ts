import { Easing, FadeIn, FadeInDown, FadeOut } from 'react-native-reanimated';

import { Motion } from '@/constants/tokens';

/**
 * Springs are critically damped and clamped: a press or a sliding indicator
 * settles without the overshoot the motion lock bans ("no bouncy spring
 * defaults", docs/visual-direction-2026-09.md).
 */
export const springSnappy = {
  damping: 30,
  stiffness: 320,
  mass: 0.9,
  overshootClamping: true,
};

export const springGentle = {
  damping: 32,
  stiffness: 200,
  mass: 1,
  overshootClamping: true,
};

export const pressScale = {
  pressed: 0.97,
  resting: 1,
  duration: Motion.duration.fast,
};

export const durations = Motion.duration;
export const easings = Motion.easing;

/** How far content rises as it fades in — enough to feel placed, not thrown. */
export const RISE_DISTANCE = 6;

export const entering = {
  fadeIn: FadeIn.duration(Motion.duration.normal).easing(easings.decelerate),
  fadeOut: FadeOut.duration(Motion.duration.fast).easing(easings.accelerate),
  /**
   * Messages and cards arrive with a fade and a slight rise from below —
   * never a sideways slide (Nocturne motion rule).
   */
  rise: FadeInDown.duration(Motion.duration.normal)
    .easing(easings.decelerate)
    .withInitialValues({ opacity: 0, transform: [{ translateY: RISE_DISTANCE }] }),
};

export const pulseTiming = {
  duration: Motion.duration.breath,
  easing: Easing.inOut(Easing.ease),
};
