import { memo, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Button, Card, Text } from '@/components/ui';
import { Motion, Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { DiscoveredGateway } from '@/lib/discovery/types';

/** Discovered gateway row — wrapped in `memo` so a Gate setup screen tick that
 * does not change `gateway`, `onAdd`, or `isScanning` does not re-render this
 * row. The row holds `useSharedValue` + `useAnimatedStyle` (Reanimated work
 * runs on every render) and is mapped across `discovery.gateways`, so a memo
 * boundary stops every parent tick from paying the Reanimated cost N times.
 */
function DiscoveredGatewayRowImpl({
  gateway,
  onAdd,
  isScanning = false,
}: {
  gateway: DiscoveredGateway;
  /** Add this row's gateway — the row supplies its own id, so the parent's
   * callback can stay referentially stable across renders. */
  onAdd: (gatewayId: string) => void;
  isScanning?: boolean;
}) {
  const tokens = useTokens();
  const secure = gateway.url.startsWith('wss://');
  const sweep = useSharedValue(0);

  useEffect(() => {
    if (isScanning) {
      sweep.value = withRepeat(
        withTiming(1, { duration: Motion.duration.slow * 2, easing: Easing.linear }),
        -1,
        false,
      );
      return;
    }

    cancelAnimation(sweep);
    sweep.value = 0;
  }, [isScanning, sweep]);

  const sweepStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -120 + sweep.value * 280 }],
    opacity: 0.55,
  }));

  return (
    <Card padding={Spacing.three} style={styles.row}>
      {isScanning ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.sweep,
            sweepStyle,
            { backgroundColor: tokens.accentMuted },
          ]}
        />
      ) : null}

      <View style={styles.meta}>
        <Text variant="caption">{gateway.name}</Text>
        <Text variant="mono" color="secondary">
          {gateway.url}
        </Text>
        <Text variant="caption" color="tertiary">
          {secure ? 'TLS' : 'LAN'}
          {gateway.tailnetDns ? ` · ${gateway.tailnetDns}` : ''}
          {gateway.tlsFingerprint ? ' · fingerprint seen' : ''}
          {isScanning ? ' · scanning…' : ''}
        </Text>
      </View>

      <Button label="Add" onPress={() => onAdd(gateway.id)} style={styles.addButton} />
    </Card>
  );
}

export const DiscoveredGatewayRow = memo(DiscoveredGatewayRowImpl);
DiscoveredGatewayRow.displayName = 'DiscoveredGatewayRow';

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
  sweep: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 72,
    borderRadius: Radius.md,
  },
  meta: {
    flex: 1,
    gap: Spacing.one,
  },
  addButton: {
    alignSelf: 'center',
    minWidth: 72,
  },
});