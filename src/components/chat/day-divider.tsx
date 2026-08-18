import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

/** Centered hairline + day label separating chat history into calendar groups. */
export function DayDivider({ label }: { label: string }) {
  const tokens = useTokens();
  return (
    <View style={styles.divider}>
      <View style={[styles.line, { backgroundColor: tokens.borderSubtle }]} />
      <Text variant="micro" color="tertiary" style={styles.label}>
        {label}
      </Text>
      <View style={[styles.line, { backgroundColor: tokens.borderSubtle }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  line: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  label: {
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
});