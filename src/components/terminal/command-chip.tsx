import * as Haptics from 'expo-haptics';
import { Pressable, StyleSheet } from 'react-native';

import { Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

export function CommandChip({ label, onPress }: { label: string; onPress: () => void }) {
  const tokens = useTokens();

  return (
    <Pressable
      style={[styles.chip, { borderColor: tokens.glassBorder, backgroundColor: tokens.glass }]}
      onPress={async () => {
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}>
      <Text variant="caption">{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
});