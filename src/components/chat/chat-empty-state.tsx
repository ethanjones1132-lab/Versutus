import { StyleSheet, View } from 'react-native';

import { Button, Card, Text } from '@/components/ui';
import { Palette, Radius, Spacing } from '@/constants/tokens';

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
      <Card padding={Spacing.four} style={styles.card}>
        <View style={styles.rule} />
        <Text variant="headline">{title}</Text>
        <Text color="secondary" style={styles.description}>
          {description}
        </Text>
        <Button label="Connect to gateway" onPress={onConnect} />
        <Button label="Go to Home" variant="ghost" onPress={onGoHome} />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
  },
  card: {
    width: '100%',
    maxWidth: 460,
    alignSelf: 'center',
    borderRadius: Radius.xl,
    gap: Spacing.three,
    borderColor: Palette.borderStrong,
  },
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Palette.accentWarm,
    opacity: 0.54,
  },
  description: {
    lineHeight: 22,
  },
});
