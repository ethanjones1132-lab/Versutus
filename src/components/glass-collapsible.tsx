import { SymbolView } from 'expo-symbols';
import { type PropsWithChildren, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Layout, useAnimatedStyle, withTiming } from 'react-native-reanimated';

import { Card, PressableScale, Text } from '@/components/ui';
import { Motion, Radius, Spacing } from '@/constants/tokens';
import { entering } from '@/lib/motion/presets';
import { useTokens } from '@/hooks/use-tokens';

export function GlassCollapsible({ children, title }: PropsWithChildren & { title: string }) {
  const tokens = useTokens();
  const [isOpen, setIsOpen] = useState(false);

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: withTiming(isOpen ? '90deg' : '0deg', { duration: Motion.duration.fast }) }],
  }));

  return (
    <Card padding={0} style={styles.wrapper}>
      <PressableScale style={styles.heading} onPress={() => setIsOpen((value) => !value)}>
        <Animated.View style={chevronStyle}>
          <SymbolView
            name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
            size={14}
            weight="bold"
            tintColor={tokens.textSecondary}
          />
        </Animated.View>
        <Text variant="caption">{title}</Text>
      </PressableScale>

      {isOpen ? (
        <Animated.View
          layout={Layout.springify().duration(Motion.duration.normal)}
          entering={entering.fadeIn}
          exiting={entering.fadeOut}>
          <View style={styles.content}>{children}</View>
        </Animated.View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    borderRadius: Radius.lg,
    overflow: 'hidden',
  },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three,
  },
  content: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.three,
    gap: Spacing.two,
  },
});