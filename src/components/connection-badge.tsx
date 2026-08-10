import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { GlassSurface, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { pulseTiming } from '@/lib/motion/presets';
import { useTokens } from '@/hooks/use-tokens';
import type { Tokens } from '@/hooks/use-tokens';
import type { ConnectionStatus } from '@/lib/gateway/types';

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  pairing: 'Needs approval',
  disconnected: 'Disconnected',
};

export function statusColor(tokens: Tokens, status: ConnectionStatus): string {
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

export function PulsingDot({ color, active }: { color: string; active: boolean }) {
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

  return (
    <GlassSurface
      variant="chip"
      padding={Spacing.two}
      style={[
        styles.pill,
        { borderColor: tokens.glassBorder },
        isPairing && {
          borderColor: tokens.accentWarm,
          borderWidth: StyleSheet.hairlineWidth * 2,
        },
      ]}>
      <View style={styles.row}>
        <PulsingDot color={color} active={isPulsing} />
        <Text
          variant="caption"
          numberOfLines={1}
          style={{ color: isPairing ? tokens.accentWarm : tokens.textSecondary }}>
          {STATUS_LABELS[status]}
          {detail && status !== 'pairing' ? ` - ${detail}` : ''}
        </Text>
      </View>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
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
