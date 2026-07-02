import { StyleSheet, View } from 'react-native';
import Animated, { Easing, Keyframe } from 'react-native-reanimated';

import { VersutusMark } from '@/components/brand/versutus-mark';
import { Palette } from '@/constants/tokens';
import { durations } from '@/lib/motion/presets';

const DURATION = durations.normal;

export function AnimatedSplashOverlay() {
  return null;
}

const logoKeyframe = new Keyframe({
  0: {
    opacity: 0,
  },
  60: {
    transform: [{ scale: 1.2 }],
    opacity: 0,
    easing: Easing.elastic(1.2),
  },
  100: {
    transform: [{ scale: 1 }],
    opacity: 1,
    easing: Easing.elastic(1.2),
  },
});

const haloKeyframe = new Keyframe({
  0: {
    opacity: 0.15,
    transform: [{ scale: 0.85 }],
  },
  100: {
    opacity: 0.5,
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
  },
});