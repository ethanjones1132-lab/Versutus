import * as Haptics from 'expo-haptics';
import { Pressable, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { GlassSurface, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { springSnappy } from '@/lib/motion/presets';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function PreviewScenarioChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <AnimatedPressable
      onPressIn={() => {
        // Reanimated shared value — mutable by design, not React state.
        // eslint-disable-next-line react-hooks/immutability
        scale.value = withSpring(0.94, springSnappy);
      }}
      onPressOut={() => {
        // Reanimated shared value — mutable by design, not React state.
        // eslint-disable-next-line react-hooks/immutability
        scale.value = withSpring(1, springSnappy);
      }}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      style={animatedStyle}>
      <GlassSurface
        variant="chip"
        padding={0}
        style={[styles.chip, active && styles.chipActive]}>
        <Text variant="caption" color={active ? 'accent' : 'secondary'} style={styles.label}>
          {label}
        </Text>
      </GlassSurface>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
  },
  chipActive: {
    borderColor: 'rgba(240, 214, 144, 0.35)',
  },
  label: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
});