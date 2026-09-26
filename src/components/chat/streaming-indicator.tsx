import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { pulseTiming } from '@/lib/motion/presets';

/**
 * The one streaming signal (visual-direction: "exactly one continuous
 * signal"): a small violet orb that breathes while a reply is being written.
 * No bouncing dots, no caret glyph in the text, no status badge beside it.
 */
export function StreamingIndicator() {
  const tokens = useTokens();
  const breath = useSharedValue(0);

  useEffect(() => {
    breath.value = withRepeat(withTiming(1, pulseTiming), -1, true);
    return () => cancelAnimation(breath);
  }, [breath]);

  const orbStyle = useAnimatedStyle(() => ({
    opacity: 0.45 + breath.value * 0.55,
    transform: [{ scale: 0.82 + breath.value * 0.18 }],
  }));

  const haloStyle = useAnimatedStyle(() => ({
    opacity: breath.value * 0.5,
    transform: [{ scale: 1 + breath.value * 0.9 }],
  }));

  return (
    <View
      style={styles.row}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Writing a reply">
      <View style={styles.stack}>
        <Animated.View style={[styles.halo, { backgroundColor: tokens.accentGlow }, haloStyle]} />
        <Animated.View style={[styles.orb, { backgroundColor: tokens.accent }, orbStyle]} />
      </View>
    </View>
  );
}

const ORB = 9;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: Spacing.one,
    paddingLeft: 2,
    minHeight: 20,
  },
  stack: {
    width: ORB,
    height: ORB,
    alignItems: 'center',
    justifyContent: 'center',
  },
  halo: {
    position: 'absolute',
    width: ORB,
    height: ORB,
    borderRadius: ORB / 2,
  },
  orb: {
    width: ORB,
    height: ORB,
    borderRadius: ORB / 2,
  },
});
