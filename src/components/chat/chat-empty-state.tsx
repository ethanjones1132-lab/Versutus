import { StyleSheet, View } from 'react-native';

import { Button, Card, Text } from '@/components/ui';
import { Palette, Radius, Spacing } from '@/constants/tokens';

export function ChatEmptyState({
  title,
  description,
  onConnect,
  onGoHome,
  onSettings,
}: {
  title: string;
  description: string;
  onConnect: () => void;
  onGoHome: () => void;
  /** Optional settings door so this empty never forces a Home detour. */
  onSettings?: () => void;
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
        {onSettings ? <Button label="Settings" variant="ghost" onPress={onSettings} /> : null}
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
    backgroundColor: Palette.accent,
  },
  description: {
    lineHeight: 22,
  },
});
