import { Pressable, StyleSheet } from 'react-native';

import { Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { haptics } from '@/lib/haptics';

export function CommandChip({ label, onPress }: { label: string; onPress: () => void }) {
  const tokens = useTokens();

  return (
    <Pressable
      style={[styles.chip, { borderColor: tokens.border, backgroundColor: tokens.backgroundElevated }]}
      onPress={async () => {
        await haptics.light();
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