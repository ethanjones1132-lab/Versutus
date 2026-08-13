import { type Href, useRouter } from 'expo-router';
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
  const runsSupported =
    connected && capabilitySnapshot.groups.find((group) => group.id === 'agent')?.status === 'ready';
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
            <Text variant="caption" numberOfLines={1} style={styles.eyebrow}>
              Active gateway
            </Text>
            <Text variant="title" numberOfLines={1} style={styles.title}>
              {activeLabel}
            </Text>
            <Text variant="caption" numberOfLines={2} style={styles.onGlassSecondary}>
              {connected
                ? runsSupported
                  ? 'Ready for chat, slash commands, and agentic runs.'
                  : 'Ready for chat and the commands this gateway offers.'
                : 'Saved locally. Select a reachable gateway to activate it.'}
            </Text>
          </View>
          <View style={styles.statusText}>
            <Badge label={statusLabel} tone={connected ? 'success' : status === 'pairing' ? 'accent' : 'neutral'} />
            {activeHello?.server?.version && connected ? (
              <Text variant="caption" color="tertiary" numberOfLines={1} style={styles.onGlassTertiary}>
                v{activeHello.server.version}
              </Text>
            ) : null}
          </View>
        </View>

        {/* Full width: connection failures name a host and a reason, and the
            cramped status column truncated them to uselessness. */}
        {!connected && statusDetail ? (
          <Text variant="caption" numberOfLines={3} style={styles.onGlassTertiary}>
            {statusDetail}
          </Text>
        ) : null}

        {lastError ? (
          // Long-pressable and generously clipped: this string is what the user
          // has to relay when a connection fails, and a truncated cause is
          // worth nothing.
          <Text variant="caption" numberOfLines={8} selectable style={styles.onGlassTertiary}>
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
          <Button
            label="Capabilities"
            onPress={async () => {
              await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              router.push('/gateway/capabilities' as Href);
            }}
            disabled={!connected}
            variant="secondary"
            style={styles.primaryAction}
          />
        </View>
        {!connected ? (
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
        ) : null}
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
      ) : runsSupported && activeRuns.length === 0 ? (
        <Card padding={Spacing.three} style={styles.runHintCard}>
          <Text variant="caption" color="accentWarm" style={styles.approvalLabel}>
            Agentic runs
          </Text>
          <Text variant="body" color="secondary">
            Start a tracked task with approval gates from Activity.
          </Text>
          <Button
            label="Open Activity"
            variant="secondary"
            size="sm"
            onPress={async () => {
              await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              router.push('/activity');
            }}
          />
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

      {/* Only for gateways that actually offer channels and report them degraded —
          on a gateway without channel admin these commands do not exist. */}
      {capabilitySnapshot.groups.find(g => g.id === 'channels' && ['unhealthy', 'partial'].includes(g.status as string)) && (
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
    flexShrink: 0,
    gap: Spacing.one,
  },
  primaryActions: {
    flexDirection: 'row',
    // No wrapping: three equal actions share one row and compress instead.
    // Wrapping put a full-width button on a second line that overlapped the
    // retry control beneath it at large system font sizes.
    alignItems: 'stretch',
    gap: Spacing.two,
  },
  primaryAction: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minHeight: 44,
    paddingHorizontal: Spacing.two,
  },
  retryAction: {
    alignSelf: 'flex-start',
  },
  approvalCard: {
    borderRadius: Radius.xl,
    borderWidth: StyleSheet.hairlineWidth * 2,
    gap: Spacing.two,
  },
  runHintCard: {
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
