import type { PropsWithChildren } from 'react';
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';

import { usePressScale } from '@/lib/motion/hooks';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type PressableScaleProps = PropsWithChildren<
  Omit<PressableProps, 'style'> & {
    style?: StyleProp<ViewStyle>;
  }
>;

export function PressableScale({ children, style, onPressIn, onPressOut, ...props }: PressableScaleProps) {
  const { animatedStyle, onPressIn: scaleIn, onPressOut: scaleOut } = usePressScale();

  return (
    <AnimatedPressable
      {...props}
      style={[animatedStyle, style]}
      onPressIn={(event) => {
        scaleIn();
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        scaleOut();
        onPressOut?.(event);
      }}>
      {children}
    </AnimatedPressable>
  );
}