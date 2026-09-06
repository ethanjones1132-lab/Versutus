import { StyleSheet, View } from 'react-native';

import { Button, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';

export function ThreadSpendGlance({ copy, onRetry }: { copy: string | undefined; onRetry?: () => void }) {
  if (!copy) return null;
  return (
    <View style={styles.wrap}>
      <Text variant="micro" color="secondary">
        {copy}
      </Text>
      {onRetry ? <Button label="Retry" variant="ghost" size="sm" onPress={onRetry} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: Spacing.three, paddingBottom: Spacing.one },
});
