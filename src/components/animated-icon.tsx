import { useState } from 'react';
import { Dimensions, StyleSheet, View } from 'react-native';
import Animated, { Easing, Keyframe } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { VersutusMark } from '@/components/brand/versutus-mark';
import { Palette } from '@/constants/tokens';
import { durations } from '@/lib/motion/presets';

const INITIAL_SCALE_FACTOR = Dimensions.get('screen').height / 90;
/** Total black-field presence, ms. Icon bloom runs inside it. */
const SPLASH_TOTAL_MS = 900;
const BLOOM_MS = 600;

/**
 * Full-screen black field that zooms in from the launcher-icon scale, holds
 * while the brand mark blooms in, then dissolves into the app. The mark beat
 * (halo + logotype) is what makes the launch feel like a product instead of a
 * blank fade — it lives inside this overlay, not in a separate mount point.
 */
export function AnimatedSplashOverlay() {
  const [visible, setVisible] = useState(true);

  if (!visible) return null;

  const splashKeyframe = new Keyframe({
    0: {
      transform: [{ scale: INITIAL_SCALE_FACTOR }],
      opacity: 1,
    },
    20: {
      opacity: 1,
    },
    78: {
      opacity: 1,
    },
    100: {
      opacity: 0,
      transform: [{ scale: 1 }],
      easing: Easing.inOut(Easing.ease),
    },
  });

  // The whole overlay (field + mark) leaves together; elastic on the scale,
  // plain inOut on the fade so opacity never attempts to overshoot.
  const markKeyframe = new Keyframe({
    0: {
      opacity: 0,
      transform: [{ scale: 0.9 }],
    },
    34: {
      opacity: 1,
      transform: [{ scale: 1 }],
      easing: Easing.out(Easing.cubic),
    },
    72: {
      opacity: 1,
    },
    100: {
      opacity: 0,
      transform: [{ scale: 1.06 }],
      easing: Easing.inOut(Easing.ease),
    },
  });

  return (
    <Animated.View
      entering={splashKeyframe.duration(SPLASH_TOTAL_MS).withCallback((finished) => {
        'worklet';
        if (finished) {
          scheduleOnRN(setVisible, false);
        }
      })}
      style={styles.backgroundSolidColor}>
      <View style={styles.center}>
        <Animated.View entering={markKeyframe.duration(SPLASH_TOTAL_MS)} style={styles.centerInner}>
          <AnimatedIcon bloomMs={BLOOM_MS} />
        </Animated.View>
      </View>
    </Animated.View>
  );
}

const logoKeyframe = new Keyframe({
  0: {
    transform: [{ scale: 1.2 }],
    opacity: 0,
  },
  45: {
    transform: [{ scale: 1.2 }],
    opacity: 0,
    easing: Easing.out(Easing.quad),
  },
  100: {
    opacity: 1,
    transform: [{ scale: 1 }],
    easing: Easing.out(Easing.back(1.4)),
  },
});

const haloKeyframe = new Keyframe({
  0: {
    opacity: 0.2,
    transform: [{ scale: 0.9 }],
  },
  100: {
    opacity: 0.55,
    transform: [{ scale: 1.05 }],
    easing: Easing.inOut(Easing.ease),
  },
});

export function AnimatedIcon({ bloomMs = durations.normal * 2 }: { bloomMs?: number }) {
  return (
    <View style={styles.iconContainer}>
      <Animated.View entering={haloKeyframe.duration(bloomMs)} style={styles.halo} />

      <Animated.View style={styles.imageContainer} entering={logoKeyframe.duration(bloomMs)}>
        <VersutusMark size={76} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  imageContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  halo: {
    width: 148,
    height: 148,
    position: 'absolute',
    borderRadius: 74,
    backgroundColor: Palette.accentMuted,
  },
  iconContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 128,
    height: 128,
  },
  center: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  centerInner: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  backgroundSolidColor: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: Palette.background,
    zIndex: 1000,
  },
});