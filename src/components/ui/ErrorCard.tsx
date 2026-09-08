import { useState } from 'react';
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
  /**
   * Collapse `affected` and `next` behind a Details toggle, leaving only the
   * cause on screen. An error the operator cannot dismiss and cannot shrink
   * held four stacked rows over the transcript for the rest of the session.
   */
  collapsible?: boolean;
  /** Render a dismiss control. Without one the card cannot be got rid of. */
  onDismiss?: () => void;
  dismissLabel?: string;
  style?: StyleProp<ViewStyle>;
};

/** Structured error surface per the luxury rules: cause, affected target, next action. */
export function ErrorCard({
  cause,
  affected,
  next,
  onRetry,
  retryLabel = 'Retry',
  collapsible = false,
  onDismiss,
  dismissLabel = 'Dismiss',
  style,
}: ErrorCardProps) {
  const tokens = useTokens();
  const [expanded, setExpanded] = useState(false);
  // Detail is worth a toggle only when there is detail to hide.
  const hasDetail = Boolean(affected || next);
  const showDetail = !collapsible || !hasDetail || expanded;

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
      {showDetail && affected ? (
        <Text variant="caption" color="secondary">
          Affected: {affected}
        </Text>
      ) : null}
      {showDetail && next ? (
        <Text variant="caption" color="secondary">
          Next: {next}
        </Text>
      ) : null}
      <View style={styles.actions}>
        {onRetry ? (
          <Button label={retryLabel} variant="ghost" size="sm" onPress={onRetry} />
        ) : null}
        {collapsible && hasDetail ? (
          <Button
            label={expanded ? 'Less' : 'Details'}
            variant="ghost"
            size="sm"
            onPress={() => setExpanded((open) => !open)}
            expanded={expanded}
          />
        ) : null}
        {onDismiss ? (
          <Button label={dismissLabel} variant="ghost" size="sm" onPress={onDismiss} />
        ) : null}
      </View>
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
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
});
