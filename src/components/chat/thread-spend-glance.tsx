import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';

export function ThreadSpendGlance({ copy }: { copy: string | undefined }) {
  if (!copy) return null;
  return (
    <View style={styles.wrap}>
      <Text variant="micro" color="secondary">
        {copy}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: Spacing.three, paddingBottom: Spacing.one },
});
