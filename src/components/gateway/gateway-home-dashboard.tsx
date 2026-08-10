import { useRouter } from 'expo-router';
import { Alert, StyleSheet, View } from 'react-native';

import * as Haptics from 'expo-haptics';

import { PulsingDot, statusColor } from '@/components/connection-badge';
import { CompactGatewayList } from '@/components/gateway/compact-gateway-list';
import { GatewayCapabilities } from '@/components/gateway/gateway-capabilities';
import { Badge, Button, Card, Icon, StatTile, Text } from '@/components/ui';
import { Palette, Radius, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useGatewayReachability } from '@/hooks/use-gateway-reachability';
import { useTokens } from '@/hooks/use-tokens';
import type { GatewayProfile } from '@/lib/gateway/types';

export function GatewayHomeDashboard() {
  const router = useRouter();
  const tokens = useTokens();
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
    activityRuns,
    pendingRunApproval,
  } = useGateway();
  const reachability = useGatewayReachability({ gateways, activeGateway, status });

  const connected = status === 'connected' && !!activeGateway;
  const activeLabel = activeGateway?.name ?? 'No active gateway';
  const activeRuns = activityRuns.filter((run) => run.status === 'running' || run.status === 'waiting-approval');
  const capabilityCount = capabilitySnapshot.groups.filter((group) =>
    ['available', 'ready', 'fresh'].includes(group.status),
  ).length;
  const orbColor = statusColor(tokens, status);
  const statusLabel = connected
    ? 'Connected'
    : status === 'connecting' || status === 'reconnecting'
      ? 'Connecting'
      : status === 'pairing'
        ? 'Needs approval'
        : 'Disconnected';

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
      <Card variant="hero" padding={Spacing.four} style={styles.summaryCard}>
        <View style={styles.heroHeader}>
          <View style={[styles.orb, { borderColor: tokens.glassHeroBorder }]}>
            <PulsingDot
              color={orbColor}
              active={status === 'connecting' || status === 'reconnecting' || status === 'pairing' || activeRuns.length > 0}
            />
          </View>
          <View style={styles.summaryText}>
            <Text variant="caption" style={styles.eyebrow}>
              Active gateway
            </Text>
            <Text variant="title" numberOfLines={1} style={styles.title}>
              {activeLabel}
            </Text>
            <Text numberOfLines={2} style={styles.onGlassSecondary}>
              {connected
                ? 'Ready for chat, tools, runs, and slash commands.'
                : 'Saved locally. Select a reachable gateway to activate it.'}
            </Text>
          </View>
          <View style={styles.statusText}>
            <Badge label={statusLabel} tone={connected ? 'success' : status === 'pairing' ? 'accent' : 'neutral'} />
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
            label="Activity"
            onPress={async () => {
              await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              router.push('/activity');
            }}
            variant="secondary"
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
        </View>
        <Button
          label="Retry connection"
          onPress={async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            void retryAutoConnect();
          }}
          variant="ghost"
          size="sm"
          style={styles.retryAction}
        />
      </Card>

      {pendingRunApproval ? (
        <Card variant="hero" padding={Spacing.three} style={[styles.approvalCard, { borderColor: tokens.accentWarm }]}>
          <View style={styles.approvalHeader}>
            <Icon
              name={{ ios: 'hand.raised.fill', android: 'pan_tool', web: 'pan_tool' }}
              size={16}
              color="accentWarm"
            />
            <Text variant="caption" color="accentWarm" style={styles.approvalLabel}>
              Run needs approval
            </Text>
          </View>
          <Text variant="body" numberOfLines={2}>
            {pendingRunApproval.prompt}
          </Text>
          <Button label="Review approval" variant="secondary" size="sm" onPress={() => router.push('/activity')} />
        </Card>
      ) : null}

      <View style={styles.statsGrid}>
        <StatTile
          label="Gateways"
          value={String(gateways.length)}
          icon={{ ios: 'network', android: 'hub', web: 'hub' }}
        />
        <StatTile
          label="Runs"
          value={String(activityRuns.length)}
          sub={activeRuns.length > 0 ? `${activeRuns.length} in flight` : undefined}
          icon={{ ios: 'bolt', android: 'bolt', web: 'bolt' }}
        />
        <StatTile
          label="Capabilities"
          value={String(capabilityCount)}
          sub={capabilitySnapshot.status}
          icon={{ ios: 'square.grid.2x2', android: 'apps', web: 'apps' }}
        />
      </View>

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
  heroHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  orb: {
    width: 56,
    height: 56,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: Palette.backgroundInset,
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
  primaryActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  primaryAction: {
    flex: 1,
    minWidth: 92,
    minHeight: 44,
  },
  retryAction: {
    alignSelf: 'flex-start',
  },
  approvalCard: {
    borderRadius: Radius.xl,
    borderWidth: StyleSheet.hairlineWidth * 2,
    gap: Spacing.two,
  },
  approvalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  approvalLabel: {
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  statsGrid: {
    flexDirection: 'row',
    gap: Spacing.two,
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
