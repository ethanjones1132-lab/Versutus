import { useCallback } from 'react';
import { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';

import { pressScale, springSnappy } from '@/lib/motion/presets';

export function usePressScale() {
  const scale = useSharedValue(pressScale.resting);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const onPressIn = useCallback(() => {
    scale.value = withTiming(pressScale.pressed, { duration: pressScale.duration });
  }, [scale]);

  const onPressOut = useCallback(() => {
    scale.value = withSpring(pressScale.resting, springSnappy);
  }, [scale]);

  return { animatedStyle, onPressIn, onPressOut };
}