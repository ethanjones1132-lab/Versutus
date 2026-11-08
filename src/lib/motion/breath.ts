/**
 * One heartbeat for everything that breathes (the tool-work breath on the
 * Veil, later the streaming orb, the listening composer, the skeleton sweep).
 * A single shared value runs a half-cycle timing that reverses forever, only
 * while at least one thing that breathes is mounted. Spec rule: no other
 * infinite loop is allowed in the app.
 */
import { useEffect } from 'react';
import { Easing, cancelAnimation, makeMutable, withRepeat, withTiming, type SharedValue } from 'react-native-reanimated';

import { LAYER_TIMING } from '@/lib/stage/layers';

import { createRefCounter } from './refcount';

// Created on first use, not when the module loads: many jest suites import the stage through a Screen
// while mocking only part of Reanimated, and a shared value built at import time would break them all.
let sharedClock: SharedValue<number> | undefined;
function clock(): SharedValue<number> {
  if (sharedClock === undefined) sharedClock = makeMutable(0);
  return sharedClock;
}

const acquire = createRefCounter(
  () => {
    clock().set(
      withRepeat(
        withTiming(1, { duration: LAYER_TIMING.breathMs / 2, easing: Easing.inOut(Easing.sin) }),
        -1,
        true,
      ),
    );
  },
  () => {
    cancelAnimation(clock());
    clock().set(0);
  },
);

/** The shared breath value (0..1..0 over `LAYER_TIMING.breathMs`); runs only while `active` somewhere. */
export function useBreath(active: boolean): SharedValue<number> {
  useEffect(() => (active ? acquire() : undefined), [active]);
  return clock();
}
