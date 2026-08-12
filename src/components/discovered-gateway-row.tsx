import { useEffect } from 'react';
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

export function DiscoveredGatewayRow({
  gateway,
  onAdd,
  isScanning = false,
}: {
  gateway: DiscoveredGateway;
  onAdd: () => void;
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

      <Button label="Add" onPress={onAdd} style={styles.addButton} />
    </Card>
  );
}

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