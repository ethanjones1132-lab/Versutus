import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

import { Button } from './Button';
import { Card } from './Card';
import { Icon } from './Icon';
import { Text } from './Text';

export type ErrorCardProps = {
  /** What went wrong. */
  cause: string;
  /** What it affects (gateway connection, session history, …). */
  affected?: string;
  /** The next action the user can take. */
  next?: string;
  onRetry?: () => void;
  retryLabel?: string;
  style?: StyleProp<ViewStyle>;
};

/** Structured error surface per the luxury rules: cause, affected target, next action. */
export function ErrorCard({ cause, affected, next, onRetry, retryLabel = 'Retry', style }: ErrorCardProps) {
  const tokens = useTokens();

  return (
    <Card
      variant="inset"
      padding={Spacing.three}
      style={[styles.card, { borderColor: tokens.statusDisconnected }, style]}>
      <View style={styles.header}>
        <Icon
          name={{ ios: 'exclamationmark.triangle', android: 'warning', web: 'warning' }}
          size={16}
          color="statusDisconnected"
        />
        <Text variant="caption" color="statusDisconnected" style={styles.eyebrow}>
          Something went wrong
        </Text>
      </View>
      <Text variant="caption" color="secondary">
        Cause: {cause}
      </Text>
      {affected ? (
        <Text variant="caption" color="secondary">
          Affected: {affected}
        </Text>
      ) : null}
      {next ? (
        <Text variant="caption" color="secondary">
          Next: {next}
        </Text>
      ) : null}
      {onRetry ? (
        <Button label={retryLabel} variant="ghost" size="sm" onPress={onRetry} style={styles.retry} />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: Spacing.one,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  eyebrow: {
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  retry: {
    alignSelf: 'flex-start',
    marginTop: Spacing.one,
  },
});
