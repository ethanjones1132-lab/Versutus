import { useCallback } from 'react';
import { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';

import { pressScale, springSnappy } from '@/lib/motion/presets';

export function usePressScale() {
  const scale = useSharedValue(pressScale.resting);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const onPressIn = useCallback(() => {
    // Reanimated shared value — mutable by design, not React state.
    // eslint-disable-next-line react-hooks/immutability
    scale.value = withTiming(pressScale.pressed, { duration: pressScale.duration });
  }, [scale]);

  const onPressOut = useCallback(() => {
    // Reanimated shared value — mutable by design, not React state.
    // eslint-disable-next-line react-hooks/immutability
    scale.value = withSpring(pressScale.resting, springSnappy);
  }, [scale]);

  return { animatedStyle, onPressIn, onPressOut };
}