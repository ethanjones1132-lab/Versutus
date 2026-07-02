import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import * as Haptics from 'expo-haptics';

import { Button, Card, Text } from '@/components/ui';
import { CompactGatewayList } from '@/components/gateway/compact-gateway-list';
import { GatewayCapabilities } from '@/components/gateway/gateway-capabilities';
import { Palette, Radius, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useGatewayReachability } from '@/hooks/use-gateway-reachability';
import { buildCapabilitySnapshot } from '@/lib/gateway/dashboard';
import type { GatewayCapabilitySnapshot } from '@/lib/gateway/types';
import type { GatewayProfile } from '@/lib/gateway/types';

export function GatewayHomeDashboard() {
  const router = useRouter();
  const {
    gateways,
    activeGateway,
    activeHello,
    status,
    statusDetail,
    lastError,
    connectGateway,
    deleteGateway,
    retryAutoConnect,
    capabilitySnapshot,
    refreshCapabilities,
  } = useGateway();
  const reachability = useGatewayReachability({ gateways, activeGateway, status });

  const connected = status === 'connected' && !!activeGateway;
  const activeLabel = activeGateway?.name ?? 'No active gateway';

  function confirmDelete(gateway: GatewayProfile) {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    Alert.alert('Remove gateway?', `${gateway.name} will stay available if discovered again.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => void deleteGateway(gateway.id),
      },
    ]);
  }

  return (
    <>
      <Card padding={Spacing.three} style={styles.summaryCard}>
        <View style={styles.metalRule} />
        <View style={styles.summaryHeader}>
          <View style={styles.summaryText}>
            <Text variant="caption" style={styles.eyebrow}>
              OpenClaw gateway
            </Text>
            <Text variant="title" numberOfLines={1} style={styles.title}>
              {activeLabel}
            </Text>
            <Text numberOfLines={2} style={styles.onGlassSecondary}>
              {connected
                ? 'Ready for chat, terminal, and slash commands.'
                : 'Saved locally. Select a reachable gateway to activate it.'}
            </Text>
          </View>
          <View style={styles.statusText}>
            <Text variant="caption" color={connected ? 'accentWarm' : 'tertiary'} style={styles.statusLabel}>
              {connected ? 'Connected' : status === 'connecting' || status === 'reconnecting' ? 'Connecting' : 'Disconnected'}
            </Text>
            {activeHello?.server?.version && connected ? (
              <Text variant="caption" color="tertiary" numberOfLines={1} style={styles.onGlassTertiary}>
                v{activeHello.server.version}
              </Text>
            ) : statusDetail ? (
              <Text variant="caption" numberOfLines={1} style={styles.onGlassTertiary}>
                {statusDetail}
              </Text>
            ) : null}
          </View>
        </View>

        {lastError ? (
          <Text variant="caption" numberOfLines={2} style={styles.onGlassTertiary}>
            {lastError}
          </Text>
        ) : null}

        <View style={styles.primaryActions}>
          <Button
            label="Chat"
            onPress={async () => {
              await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              router.push('/chat');
            }}
            disabled={!connected}
            style={styles.primaryAction}
          />
          <Button
            label="Tools"
            onPress={async () => {
              await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              router.push('/terminal');
            }}
            disabled={!activeGateway}
            variant="secondary"
            style={styles.primaryAction}
          />
          <Button
            label="Retry connection"
            onPress={async () => {
              await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              void retryAutoConnect();
            }}
            variant="ghost"
            style={styles.retryAction}
          />
        </View>
      </Card>

      <View style={styles.sectionHeader}>
        <Text variant="caption">Gateways</Text>
        <Button
          label="Add"
          variant="secondary"
          onPress={() => router.push('/gateway/add')}
          style={styles.headerButton}
        />
      </View>
      <CompactGatewayList
        gateways={gateways}
        activeGatewayId={activeGateway?.id}
        status={status}
        statusDetail={statusDetail}
        reachability={reachability}
        onSelect={(gateway) => void connectGateway(gateway)}
        onDelete={confirmDelete}
      />

      <GatewayCapabilities snapshot={capabilitySnapshot} />
      <Button
        label="Refresh capabilities"
        variant="ghost"
        onPress={async () => {
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          void refreshCapabilities();
        }}
        style={{ alignSelf: 'flex-end', marginTop: -Spacing.one }}
      />

      {/* Phase 6: Channel repair cards for degraded states */}
      {capabilitySnapshot.groups.find(g => g.id === 'channels' && ['stale', 'warming', 'unhealthy', 'partial', 'unknown'].includes(g.status as string)) && (
        <Card padding={Spacing.two} style={{ marginTop: Spacing.two }}>
          <Text variant="caption" color="accentWarm">Channel Repair</Text>
          <Text color="secondary" style={{ marginTop: Spacing.one }}>
            Some channels are degraded. Use /channel start &lt;name&gt;, /channel stop, or /channel logout.
          </Text>
          <Button label="Open chat to manage channels" variant="ghost" onPress={() => router.push('/chat')} style={{ marginTop: Spacing.one }} />
        </Card>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  summaryCard: {
    borderRadius: Radius.xl,
    gap: Spacing.three,
    borderColor: Palette.borderStrong,
  },
  metalRule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Palette.accentWarm,
    opacity: 0.55,
  },
  summaryHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  summaryText: {
    flex: 1,
    minWidth: 0,
    gap: Spacing.one,
  },
  eyebrow: {
    color: Palette.accentWarm,
    textTransform: 'uppercase',
  },
  title: {
    color: Palette.textPrimary,
  },
  statusText: {
    alignItems: 'flex-end',
    maxWidth: 132,
    gap: Spacing.one,
  },
  statusLabel: {
    textTransform: 'uppercase',
  },
  primaryActions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  primaryAction: {
    flex: 1,
    minHeight: 44,
  },
  retryAction: {
    minWidth: 82,
    minHeight: 44,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  headerButton: {
    minHeight: 38,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
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
