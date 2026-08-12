import { StyleSheet, View } from 'react-native';

import { ConnectionBadge } from '@/components/connection-badge';
import { Button, Card, Text } from '@/components/ui';
import { Palette, Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { GatewayReachability, GatewayReachabilityState } from '@/lib/gateway/dashboard';
import type { ConnectionStatus, GatewayProfile } from '@/lib/gateway/types';

export function CompactGatewayList({
  gateways,
  activeGatewayId,
  status,
  statusDetail,
  reachability,
  onSelect,
  onDelete,
}: {
  gateways: GatewayProfile[];
  activeGatewayId?: string;
  status: ConnectionStatus;
  statusDetail?: string;
  reachability: Record<string, GatewayReachability>;
  onSelect: (gateway: GatewayProfile) => void;
  onDelete: (gateway: GatewayProfile) => void;
}) {
  if (gateways.length === 0) {
    return (
      <Card padding={Spacing.three} style={styles.emptyCard}>
        <Text variant="caption" style={styles.onGlassPrimary}>No gateways saved</Text>
        <Text variant="caption" style={styles.onGlassSecondary}>
          Add your first gateway (Hermes, Gate, or OpenClaw) to unlock chat, tools, and commands.
        </Text>
      </Card>
    );
  }

  return (
    <View style={styles.list}>
      {gateways.map((gateway) => {
        const isActive = gateway.id === activeGatewayId;
        return (
          <GatewayRow
            key={gateway.id}
            gateway={gateway}
            isActive={isActive}
            status={status}
            statusDetail={statusDetail}
            reachability={reachability[gateway.id]}
            onSelect={() => onSelect(gateway)}
            onDelete={() => onDelete(gateway)}
          />
        );
      })}
    </View>
  );
}

function GatewayRow({
  gateway,
  isActive,
  status,
  statusDetail,
  reachability,
  onSelect,
  onDelete,
}: {
  gateway: GatewayProfile;
  isActive: boolean;
  status: ConnectionStatus;
  statusDetail?: string;
  reachability?: GatewayReachability;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const tokens = useTokens();
  const secureLabel =
    gateway.discoverySource === 'tailscale' || gateway.url.startsWith('wss://')
      ? 'Tailscale/TLS'
      : gateway.discoverySource ?? 'manual';

  return (
    <Card
      padding={Spacing.three}
      style={[
        styles.rowCard,
        isActive && {
          borderColor: tokens.accentWarm,
          borderWidth: 1,
        },
      ]}>
      <View style={styles.rowTop}>
        <View style={styles.titleBlock}>
          <View style={styles.titleRow}>
            <Text variant="caption" numberOfLines={1} style={styles.onGlassPrimary}>
              {gateway.name}
            </Text>
            {isActive ? (
              <Text variant="caption" color="accent">
                Active
              </Text>
            ) : null}
          </View>
          <Text variant="mono" numberOfLines={1} style={styles.onGlassSecondary}>
            {gateway.url}
          </Text>
          <Text variant="caption" numberOfLines={1} style={styles.onGlassTertiary}>
            {secureLabel} - {gateway.sessionKey}
          </Text>
        </View>

        {isActive ? (
          <ConnectionBadge status={status} detail={statusDetail} />
        ) : (
          <ReachabilityPill state={reachability?.state ?? 'unknown'} latencyMs={reachability?.latencyMs} />
        )}
      </View>

      <View style={styles.actions}>
        <Button
          label={isActive ? 'Reconnect' : 'Connect'}
          onPress={onSelect}
          variant={isActive ? 'secondary' : 'primary'}
          style={styles.actionButton}
        />
        <Button label="Remove" onPress={onDelete} variant="ghost" style={styles.deleteButton} />
      </View>
    </Card>
  );
}

function ReachabilityPill({
  state,
  latencyMs,
}: {
  state: GatewayReachabilityState;
  latencyMs?: number;
}) {
  const tokens = useTokens();
  const label =
    state === 'connected'
      ? 'Connected'
      : state === 'reachable'
        ? latencyMs
          ? `${latencyMs} ms`
          : 'Reachable'
        : state === 'unreachable'
          ? 'Offline'
          : state === 'checking'
            ? 'Checking'
            : 'Unknown';
  const color =
    state === 'connected' || state === 'reachable'
      ? tokens.statusConnected
      : state === 'checking'
        ? tokens.statusConnecting
        : state === 'unreachable'
          ? tokens.statusDisconnected
          : tokens.textTertiary;

  return (
    <View style={[styles.pill, { borderColor: tokens.glassBorder, backgroundColor: tokens.backgroundInset }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text variant="caption" numberOfLines={1} style={styles.onGlassSecondary}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: Spacing.two,
  },
  emptyCard: {
    borderRadius: Radius.md,
    gap: Spacing.one,
  },
  rowCard: {
    borderRadius: Radius.md,
    gap: Spacing.two,
    borderColor: Palette.border,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
    gap: Spacing.one,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  pill: {
    minHeight: 32,
    maxWidth: 128,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.two,
    borderRadius: Radius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  actionButton: {
    flex: 1,
    minHeight: 42,
  },
  deleteButton: {
    minWidth: 92,
    minHeight: 42,
  },
  onGlassPrimary: {
    color: Palette.textPrimary,
  },
  onGlassSecondary: {
    color: Palette.textSecondary,
  },
  onGlassTertiary: {
    color: Palette.textTertiary,
  },
});
