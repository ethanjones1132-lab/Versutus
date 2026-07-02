import { Easing, FadeIn, FadeOut, SlideInLeft, SlideInRight } from 'react-native-reanimated';

import { Motion } from '@/constants/tokens';

export const springSnappy = {
  damping: 18,
  stiffness: 220,
  mass: 0.8,
};

export const springGentle = {
  damping: 22,
  stiffness: 160,
  mass: 1,
};

export const pressScale = {
  pressed: 0.97,
  resting: 1,
  duration: Motion.duration.fast,
};

export const durations = Motion.duration;
export const easings = Motion.easing;

export const entering = {
  fadeIn: FadeIn.duration(Motion.duration.normal).easing(easings.decelerate),
  fadeOut: FadeOut.duration(Motion.duration.fast).easing(easings.accelerate),
  slideInLeft: SlideInLeft.duration(Motion.duration.normal).easing(easings.decelerate),
  slideInRight: SlideInRight.duration(Motion.duration.normal).easing(easings.decelerate),
};

export const pulseTiming = {
  duration: Motion.duration.slow,
  easing: Easing.inOut(Easing.ease),
};