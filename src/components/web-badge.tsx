import { StyleSheet, View } from 'react-native';

import { VersutusLogotype } from '@/components/brand';
import { Spacing } from '@/constants/tokens';

export function WebBadge() {
  return (
    <View style={styles.badge}>
      <VersutusLogotype variant="compact" showMark />
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignItems: 'center',
    padding: Spacing.five,
  },
});