import type { ReactNode } from 'react';
import { Platform } from 'react-native';
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { composerKeyboardLift } from '@/lib/motion/keyboard-lift';

type ComposerKeyboardLiftProps = {
  children: ReactNode;
};

/** Android: pad by IME height minus the bottom inset Screen already applied. iOS: no-op (KAV owns lift). */
export function ComposerKeyboardLift({ children }: ComposerKeyboardLiftProps) {
  const keyboard = useAnimatedKeyboard({
    isStatusBarTranslucentAndroid: true,
    isNavigationBarTranslucentAndroid: true,
  });
  const insets = useSafeAreaInsets();
  const liftStyle = useAnimatedStyle(() => ({
    paddingBottom:
      Platform.OS === 'android'
        ? composerKeyboardLift(keyboard.height.value, insets.bottom)
        : 0,
  }));

  return <Animated.View style={liftStyle}>{children}</Animated.View>;
}
