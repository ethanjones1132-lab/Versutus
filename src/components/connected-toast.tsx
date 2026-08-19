import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useTokens } from '@/hooks/use-tokens';
import { formatConnectedToastLabel } from '@/lib/format';
import type { ConnectionStatus } from '@/lib/gateway/types';

const HOLD_MS = 2000;

/**
 * Connected-ceremony HUD toast. Mounted once at the app root: when the gateway
 * flips to `connected` (user-initiated connect or a recovery after a drop) a
 * brief slide-down toast punctuates the win — the status badge alone flips
 * silently and the user never notices the connection landed. The very first
 * mount does not toast (that is just app launch).
 */
export function ConnectedToast() {
  const tokens = useTokens();
  const insets = useSafeAreaInsets();
  const { status, activeGateway, activeHello } = useGateway();
  const [visible, setVisible] = useState(false);
  const [label, setLabel] = useState('Gateway online');
  const prevRef = useRef<ConnectionStatus | null>(null);

  const opacity = useSharedValue(0);
  const translateY = useSharedValue(-16);

  useEffect(() => {
    const previous = prevRef.current;
    prevRef.current = status;
    if (status !== 'connected') return;
    // Skip the initial mount and unchanged connected state.
    if (previous === null || previous === 'connected') return;

    setLabel(
      formatConnectedToastLabel({
        gatewayName: activeGateway?.name,
        version: activeHello?.server?.version,
      }),
    );
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), HOLD_MS);
    return () => clearTimeout(timer);
  }, [activeGateway, activeHello, status]);

  useEffect(() => {
    opacity.value = withTiming(visible ? 1 : 0, { duration: visible ? 240 : 180 });
    translateY.value = withTiming(visible ? 0 : -16, { duration: visible ? 240 : 180 });
  }, [opacity, translateY, visible]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <View pointerEvents="none" style={[styles.host, { top: insets.top + Spacing.two }]}>
      <Animated.View
        style={[
          styles.toast,
          animatedStyle,
          {
            backgroundColor: tokens.backgroundRaised,
            borderColor: tokens.statusConnectedMuted,
            shadowColor: '#000',
          },
        ]}>
        <View style={[styles.dot, { backgroundColor: tokens.statusConnected }]} />
        <Text variant="caption" color="primary" style={styles.label} numberOfLines={1}>
          {label}
        </Text>
        <Text variant="micro" color="statusConnected">
          gateway online
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 999,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: '88%',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    flexShrink: 1,
  },
});
