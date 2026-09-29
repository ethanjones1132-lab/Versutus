import { Link } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { Card, Icon, Text } from '@/components/ui';
import { Palette, Radius, Spacing } from '@/constants/tokens';
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
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Spend. Tokens and cost across this gateway's sessions, per Bot where the gateway can split them.">
        <Card variant="stage" padding={Spacing.three - 2} style={styles.card}>
          <View style={styles.tile}>
            <Icon name={{ ios: 'chart.bar', android: 'bar_chart', web: 'bar_chart' }} size={16} color="accent" />
          </View>
          <View style={styles.title}>
            <Text variant="body">Spend</Text>
            <Text variant="caption" color="secondary" numberOfLines={1}>
              What this gateway has cost, per Bot
            </Text>
          </View>
          <Icon
            name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
            size={14}
            color="textTertiary"
          />
        </Card>
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three - 4,
  },
  tile: {
    width: 32,
    height: 32,
    borderRadius: Radius.sm + 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Palette.backgroundRaised,
  },
  title: {
    flex: 1,
    gap: 2,
  },
});
