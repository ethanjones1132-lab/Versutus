import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';

/**
 * The day a stretch of the conversation happened, set quietly in the space
 * between turns — no rules, no capitals. Space already separates the days;
 * the label only names them.
 */
export function DayDivider({ label }: { label: string }) {
  return (
    <View style={styles.divider}>
      <Text variant="micro" color="tertiary" style={styles.label}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  divider: {
    alignItems: 'center',
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
  },
  label: {
    letterSpacing: 0.3,
  },
});
