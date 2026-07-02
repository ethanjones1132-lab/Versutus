import { Button as SwiftButton, ContentUnavailableView, Host } from '@expo/ui/swift-ui';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui';
import { Spacing } from '@/constants/tokens';

export function ChatEmptyState({
  title,
  description,
  onConnect,
  onGoHome,
}: {
  title: string;
  description: string;
  onConnect: () => void;
  onGoHome: () => void;
}) {
  return (
    <View style={styles.fallback}>
      <Host style={styles.host}>
        <ContentUnavailableView title={title} description={description} systemImage="bubble.left.and.bubble.right" />
      </Host>
      <Button label="Connect to gateway" onPress={onConnect} />
      <SwiftButton label="Go to Home" onPress={onGoHome} />
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    padding: Spacing.four,
  },
  host: {
    minHeight: 180,
    alignSelf: 'stretch',
  },
});