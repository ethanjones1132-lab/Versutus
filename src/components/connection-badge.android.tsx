import { AssistChip, Host, Text as ComposeText } from '@expo/ui/jetpack-compose';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { pulseTiming } from '@/lib/motion/presets';
import { useTokens } from '@/hooks/use-tokens';
import type { ConnectionStatus } from '@/lib/gateway/types';

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  pairing: 'Needs approval',
  disconnected: 'Disconnected',
};

function statusColor(tokens: ReturnType<typeof useTokens>, status: ConnectionStatus): string {
  switch (status) {
    case 'connected':
      return tokens.statusConnected;
    case 'connecting':
    case 'reconnecting':
      return tokens.statusConnecting;
    case 'pairing':
      return tokens.statusPairing;
    default:
      return tokens.statusDisconnected;
  }
}

function PulsingDot({ color, active }: { color: string; active: boolean }) {
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (active) {
      scale.value = withRepeat(
        withTiming(1.35, { duration: pulseTiming.duration, easing: pulseTiming.easing }),
        -1,
        true,
      );
      opacity.value = withRepeat(
        withTiming(0.4, { duration: pulseTiming.duration, easing: pulseTiming.easing }),
        -1,
        true,
      );
      return;
    }

    cancelAnimation(scale);
    cancelAnimation(opacity);
    scale.value = 1;
    opacity.value = 1;
  }, [active, opacity, scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  return (
    <View style={styles.dotWrap}>
      <Animated.View style={[styles.dot, { backgroundColor: color }, animatedStyle]} />
    </View>
  );
}

export function ConnectionBadge({
  status,
  detail,
}: {
  status: ConnectionStatus;
  detail?: string;
}) {
  const tokens = useTokens();
  const color = statusColor(tokens, status);
  const isPulsing = status === 'connecting' || status === 'reconnecting';
  const isPairing = status === 'pairing';
  const label = `${STATUS_LABELS[status]}${detail && status !== 'pairing' ? ` · ${detail}` : ''}`;

  return (
    <View style={styles.row}>
      <PulsingDot color={color} active={isPulsing} />
      <Host matchContents style={styles.chipHost}>
        <AssistChip
          colors={{
            containerColor: isPairing ? tokens.accentWarmMuted : tokens.backgroundElevated,
            labelColor: isPairing ? tokens.accentWarm : tokens.textSecondary,
          }}>
          <AssistChip.Label>
            <ComposeText
              color={isPairing ? tokens.accentWarm : tokens.textSecondary}
              style={{ fontSize: 12, fontWeight: '500' }}>
              {label}
            </ComposeText>
          </AssistChip.Label>
        </AssistChip>
      </Host>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
  },
  chipHost: {
    alignSelf: 'flex-start',
  },
  dotWrap: {
    width: 10,
    height: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});