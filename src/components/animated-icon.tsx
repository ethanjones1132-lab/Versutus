import { useState } from 'react';
import { Dimensions, StyleSheet, View } from 'react-native';
import Animated, { Easing, Keyframe } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { VersutusMark } from '@/components/brand/versutus-mark';
import { Palette } from '@/constants/tokens';
import { durations } from '@/lib/motion/presets';

const INITIAL_SCALE_FACTOR = Dimensions.get('screen').height / 90;
const DURATION = durations.normal;

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
    70: {
      opacity: 0,
      easing: Easing.elastic(0.7),
    },
    100: {
      opacity: 0,
      transform: [{ scale: 1 }],
      easing: Easing.elastic(0.7),
    },
  });

  return (
    <Animated.View
      entering={splashKeyframe.duration(DURATION).withCallback((finished) => {
        'worklet';
        if (finished) {
          scheduleOnRN(setVisible, false);
        }
      })}
      style={styles.backgroundSolidColor}
    />
  );
}

const logoKeyframe = new Keyframe({
  0: {
    transform: [{ scale: 1.2 }],
    opacity: 0,
  },
  40: {
    transform: [{ scale: 1.2 }],
    opacity: 0,
    easing: Easing.elastic(0.7),
  },
  100: {
    opacity: 1,
    transform: [{ scale: 1 }],
    easing: Easing.elastic(0.7),
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

export function AnimatedIcon() {
  return (
    <View style={styles.iconContainer}>
      <Animated.View entering={haloKeyframe.duration(DURATION * 2)} style={styles.halo} />

      <Animated.View style={styles.imageContainer} entering={logoKeyframe.duration(DURATION)}>
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
    zIndex: 100,
  },
  backgroundSolidColor: {
    ...StyleSheet.absoluteFill,
    backgroundColor: Palette.background,
    zIndex: 1000,
  },
});