import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { Motion, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

function Dot({ delay }: { delay: number }) {
  const tokens = useTokens();
  const offset = useSharedValue(0);

  useEffect(() => {
    offset.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(-4, { duration: Motion.duration.fast, easing: Easing.out(Easing.ease) }),
          withTiming(0, { duration: Motion.duration.fast, easing: Easing.in(Easing.ease) }),
        ),
        -1,
        false,
      ),
    );
    return () => cancelAnimation(offset);
  }, [delay, offset]);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: offset.value }],
  }));

  return <Animated.View style={[styles.dot, { backgroundColor: tokens.textSecondary }, style]} />;
}

export function StreamingIndicator() {
  return (
    <View style={styles.row}>
      <Dot delay={0} />
      <Dot delay={120} />
      <Dot delay={240} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingTop: Spacing.one,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});