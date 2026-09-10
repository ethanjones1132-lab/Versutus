import { Link } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { Card, Icon, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';

/**
 * The way into P5's Spend screen, on the two surfaces the spec names: gateway
 * settings and the Activity tab (`FUTURE-ITEMS.md:697`).
 *
 * Every number on that screen is read from the connected gateway, so the row
 * is offered only while that connection is up: on a disconnected screen it
 * would open a route whose only honest answer is that it has nothing to read.
 * The route keeps its own gate; this one just declines to offer the trip.
 *
 * The copy is the screen's own claim in the project's words — tokens and cost
 * across this gateway's sessions, per Bot where the gateway can split them —
 * and nothing here folds or formats a number.
 */
export function SpendEntryRow() {
  const { status } = useGateway();
  if (status !== 'connected') return null;

  return (
    <Link href="/gateway/spend" asChild>
      <Pressable accessibilityRole="button">
        <Card variant="surface" padding={Spacing.three} style={styles.card}>
          <View style={styles.heading}>
            <View style={styles.title}>
              <Text variant="caption" color="accentWarm" style={styles.eyebrow}>
                Spend
              </Text>
              <Text variant="headline">What this gateway has cost</Text>
            </View>
            <Icon
              name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
              size={18}
              color="textTertiary"
            />
          </View>
          <Text variant="caption" color="secondary">
            Tokens and cost across this gateway&apos;s sessions, per Bot where the gateway can split them.
          </Text>
        </Card>
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.lg,
    gap: Spacing.two,
  },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  title: {
    flex: 1,
    gap: Spacing.one,
  },
  eyebrow: {
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
});
