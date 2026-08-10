import { StyleSheet, View } from 'react-native';

import { PulsingDot, statusColor } from '@/components/connection-badge';
import { Chip, GlassSurface, Icon, PressableScale, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { ConnectionStatus } from '@/lib/gateway/types';

export type ChatHeaderProps = {
  gatewayName: string;
  status: ConnectionStatus;
  statusDetail?: string;
  streaming?: boolean;
  sessionLabel?: string;
  modelLabel?: string;
  onSessionPress?: () => void;
  onModelPress?: () => void;
  onOverflowPress?: () => void;
};

/** Slim contextual chat header: orb, gateway, quick model/session chips, overflow. */
export function ChatHeader({
  gatewayName,
  status,
  statusDetail,
  streaming = false,
  sessionLabel,
  modelLabel,
  onSessionPress,
  onModelPress,
  onOverflowPress,
}: ChatHeaderProps) {
  const tokens = useTokens();
  const color = statusColor(tokens, status);
  const pulsing = streaming || status === 'connecting' || status === 'reconnecting' || status === 'pairing';

  return (
    <View style={styles.wrap}>
      <GlassSurface variant="hero" radius={Radius.xl} padding={Spacing.two} style={styles.card}>
        <View style={[styles.orbHalo, { borderColor: tokens.glassBorder }]}>
          <PulsingDot color={color} active={pulsing} />
        </View>
        <View style={styles.titles}>
          <Text variant="headline" numberOfLines={1} style={styles.name}>
            {gatewayName}
          </Text>
          <Text variant="micro" color="secondary" numberOfLines={1}>
            {streaming ? 'Streaming response…' : statusDetail || 'Ready for chat and slash commands'}
          </Text>
        </View>

        {modelLabel && onModelPress ? (
          <Chip
            label={modelLabel}
            icon={{ ios: 'cpu', android: 'memory', web: 'memory' }}
            onPress={onModelPress}
            style={styles.chip}
          />
        ) : null}
        {sessionLabel && onSessionPress ? (
          <Chip
            label={sessionLabel}
            icon={{ ios: 'bubble.left.and.bubble.right', android: 'chat', web: 'chat' }}
            onPress={onSessionPress}
            style={styles.chip}
          />
        ) : null}
        {onOverflowPress ? (
          <PressableScale
            onPress={onOverflowPress}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Chat options"
            style={styles.overflow}>
            <Icon
              name={{ ios: 'ellipsis', android: 'more_vert', web: 'more_vert' }}
              size={18}
              color="textSecondary"
            />
          </PressableScale>
        ) : null}
      </GlassSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.two,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  orbHalo: {
    width: 34,
    height: 34,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  titles: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  name: {
    fontSize: 17,
    lineHeight: 22,
  },
  chip: {
    maxWidth: 120,
  },
  overflow: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
