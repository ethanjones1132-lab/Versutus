// ─── The call's light ─────────────────────────────────────────────────────
// One orb, five behaviours, each a different kind of motion so the state reads
// without the label: a slow breath while the call is getting ready, a steady
// light that swells with your voice while it can hear you, a small light
// circling while it works on an answer, rings leaving it while it talks, and a
// hollow, still ring while the microphone is off.
//
// It is plain views driven by Reanimated shared values, so every frame is
// drawn on the UI thread and the banner around it never re-renders for motion:
// the microphone level arrives ten times a second and is read in a worklet.
// The first indicator was a Skia dot scaled by the raw level, which is a few
// hundredths for ordinary speech — it moved a pixel, and looked broken.
//
// It is never load-bearing. No logic reads it, and with motion reduced in the
// system settings each state keeps its shape and simply holds still.

import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { callOrbGain, type CallOrbMode } from '@/lib/voice/call-orb-motion';

export type HandsfreeCallIndicatorProps = {
  /** What the call is doing; decides the kind of motion. */
  mode: CallOrbMode;
  /**
   * The live 0–1 microphone level, held by the provider as a shared value so
   * the orb reads it on the UI thread. It stays 0 where the platform has none,
   * and the orb then shows the state without the voice.
   */
  level: SharedValue<number>;
  /** The light's colour, and the colour of the still ring while muted. */
  color: string;
  mutedColor: string;
  size?: number;
};

/** One breath, one orbit, one ring: how long each takes in each state. */
const BREATH_MS: Record<CallOrbMode, number> = {
  connecting: 1400,
  listening: 2800,
  thinking: 1400,
  speaking: 1000,
  muted: 0,
};
const ORBIT_MS = 1200;
const RING_MS = 1500;
/** How quickly the orb follows the voice, as time constants: it rises with a
 * syllable almost at once and settles more slowly, so ten samples a second
 * read as one movement and not ten steps. */
const GAIN_RISE_MS = 55;
const GAIN_FALL_MS = 190;

export function HandsfreeCallIndicator({
  mode,
  level,
  color,
  mutedColor,
  size = 44,
}: HandsfreeCallIndicatorProps) {
  const reducedMotion = useReducedMotion();
  // Each runs 0 → 1 on its own clock; the styles below turn them into shape.
  const breath = useSharedValue(0);
  const orbit = useSharedValue(0);
  const ring = useSharedValue(0);
  const gain = useSharedValue(0);

  // The voice: on every frame the orb moves part of the way towards the
  // loudness of the latest sample, all on the UI thread. A frame follower and
  // not an animation started per sample: one restarted every time the level
  // changed never got past its first frame when the level changed every frame.
  // It runs only while listening — otherwise the orb is not the microphone's
  // to move, and nothing ticks.
  const follower = useFrameCallback((frame) => {
    const elapsed = frame.timeSincePreviousFrame ?? 16;
    const target = callOrbGain(level.value);
    const current = gain.get();
    const constant = target > current ? GAIN_RISE_MS : GAIN_FALL_MS;
    gain.set(current + (target - current) * (1 - Math.exp(-elapsed / constant)));
  }, false);

  useEffect(() => {
    const following = mode === 'listening' && !reducedMotion;
    follower.setActive(following);
    if (!following) gain.set(withTiming(0, { duration: GAIN_FALL_MS }));
    return () => follower.setActive(false);
  }, [mode, reducedMotion, follower, gain]);

  useEffect(() => {
    cancelAnimation(breath);
    cancelAnimation(orbit);
    cancelAnimation(ring);
    breath.value = 0;
    orbit.value = 0;
    ring.value = 0;
    if (reducedMotion || mode === 'muted') return;
    breath.value = withRepeat(
      withTiming(1, { duration: BREATH_MS[mode], easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    if (mode === 'thinking') {
      orbit.value = withRepeat(withTiming(1, { duration: ORBIT_MS, easing: Easing.linear }), -1, false);
    }
    if (mode === 'speaking') {
      ring.value = withRepeat(withTiming(1, { duration: RING_MS, easing: Easing.out(Easing.quad) }), -1, false);
    }
    return () => {
      cancelAnimation(breath);
      cancelAnimation(orbit);
      cancelAnimation(ring);
    };
  }, [mode, reducedMotion, breath, orbit, ring]);

  const haloStyle = useAnimatedStyle(() => ({
    opacity: 0.16 + breath.value * 0.1 + gain.value * 0.3,
    transform: [{ scale: 0.7 + breath.value * 0.08 + gain.value * 0.3 }],
  }));
  const coreStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 0.94 + breath.value * 0.06 + gain.value * 0.14 }],
  }));
  const ringStyle = useAnimatedStyle(() => ({
    opacity: (1 - ring.value) * 0.45,
    transform: [{ scale: 0.5 + ring.value * 0.5 }],
  }));
  const orbitStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${orbit.value * 360}deg` }],
  }));

  const muted = mode === 'muted';
  const coreSize = Math.round(size * 0.4);
  const dot = Math.max(4, Math.round(size * 0.14));

  return (
    <View
      style={[styles.frame, { width: size, height: size }]}
      // The label beside it says the state in words; this is its picture.
      accessible={false}
      importantForAccessibility="no-hide-descendants">
      {muted ? null : (
        <Animated.View
          style={[styles.fill, { borderRadius: size / 2, backgroundColor: color }, haloStyle]}
        />
      )}
      {mode === 'speaking' ? (
        <Animated.View
          style={[
            styles.fill,
            { borderRadius: size / 2, borderWidth: 2, borderColor: color },
            reducedMotion ? styles.stillRing : ringStyle,
          ]}
        />
      ) : null}
      {mode === 'thinking' ? (
        <Animated.View style={[styles.fill, styles.orbit, orbitStyle]}>
          <View style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: color }} />
        </Animated.View>
      ) : null}
      <Animated.View
        style={[
          {
            width: coreSize,
            height: coreSize,
            borderRadius: coreSize / 2,
          },
          muted
            ? { borderWidth: 2, borderColor: mutedColor }
            : { backgroundColor: color, opacity: mode === 'connecting' ? 0.55 : 1 },
          coreStyle,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  fill: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  // The circling light rides the top edge of a frame that turns as a whole.
  orbit: {
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  stillRing: {
    opacity: 0.4,
    transform: [{ scale: 0.82 }],
  },
});
