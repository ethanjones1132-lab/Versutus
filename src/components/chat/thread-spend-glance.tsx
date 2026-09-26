import { StyleSheet, View } from 'react-native';

import { Button, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';

/**
 * What this thread has cost, as one quiet line under the header. A failed
 * first read keeps its Retry on the same line, so the glance never grows a
 * second row above the conversation.
 */
export function ThreadSpendGlance({ copy, onRetry }: { copy: string | undefined; onRetry?: () => void }) {
  if (!copy) return null;
  return (
    <View style={styles.wrap}>
      <Text variant="micro" color="tertiary">
        {copy}
      </Text>
      {onRetry ? <Button label="Retry" variant="ghost" size="sm" onPress={onRetry} style={styles.retry} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.one,
    minHeight: 20,
  },
  retry: {
    minHeight: 28,
    paddingVertical: 0,
    paddingHorizontal: Spacing.two,
  },
});
