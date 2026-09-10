import { type Href, Link, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import * as Haptics from 'expo-haptics';

import { PulsingDot, statusColor } from '@/components/connection-badge';
import { DiscoveredGatewayRow } from '@/components/discovered-gateway-row';
import { CapabilityHive } from '@/components/gateway/capability-hive';
import { ChannelStatusRow } from '@/components/gateway/channel-status-row';
import { CompactGatewayList } from '@/components/gateway/compact-gateway-list';
import { GatewayCapabilities } from '@/components/gateway/gateway-capabilities';
import { HealthChecksPane } from '@/components/gateway/health-checks-pane';
import { PairedDevicesPane } from '@/components/gateway/paired-devices-pane';
import { GlassCollapsible } from '@/components/glass-collapsible';
import { HomeBriefingCard } from '@/components/home-briefing-card';
import { HomeStatusCard } from '@/components/home-status-card';
import { PairingPanel } from '@/components/pairing-panel';
import { Badge, Button, Card, ConfirmSheet, ErrorCard, Icon, PressableScale, StatTile, Text } from '@/components/ui';
import { Palette, Radius, Spacing } from '@/constants/tokens';
import { CHIP_HIT_SLOP } from '@/lib/motion/chip-hit-slop';
import { useGateway } from '@/context/gateway-provider';
import { useGatewayDiscovery } from '@/hooks/use-gateway-discovery';
import { useGatewayReachability } from '@/hooks/use-gateway-reachability';
import { useTokens } from '@/hooks/use-tokens';
import { describeAutoRetry } from '@/lib/connection/retry-ladder';
import { describeGatewayError, humanizeGatewayError } from '@/lib/gateway/error-humanizer';
import type { GatewayProfile } from '@/lib/gateway/types';
import { describeHomeEmptyState } from '@/lib/home/home-empty-state';
import { homeHeroPrimaryActions } from '@/lib/home/home-hero-actions';

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
    addGateway,
    deleteGateway,
    retryAutoConnect,
    autoRetry,
    capabilitySnapshot,
    refreshCapabilities,
    activityRuns,
    pendingRunApproval,
    settings,
    connectionPhase,
    probeMessage,
    deviceId,
    pairingDetails,
  } = useGateway();
  const reachability = useGatewayReachability({ gateways, activeGateway, status });
  const discovery = useGatewayDiscovery(true);
  const [deleteCandidate, setDeleteCandidate] = useState<GatewayProfile | null>(null);
  // Default collapsed keeps the disconnected card slim; a tap on either hero
  // line reveals the full reason it gave up / the backoff schedule.
  const [statusExpanded, setStatusExpanded] = useState(false);
  const [retryExpanded, setRetryExpanded] = useState(false);

  // Derived dashboard values — memoized so a streamed frame that only changed
  // messages does not re-run the gateway list, run filter, capability count,
  // channel glance or runs-supported flag (iter-099). These live above the
  // empty-state early return so the hooks run in the same order every render.
  const connected = status === 'connected' && !!activeGateway;
  const activeRuns = useMemo(
    () => activityRuns.filter((run) => run.status === 'running' || run.status === 'waiting-approval'),
    [activityRuns],
  );
  const capabilityCount = useMemo(
    () =>
      capabilitySnapshot.groups.filter((group) =>
        ['available', 'ready', 'fresh'].includes(group.status),
      ).length,
    [capabilitySnapshot.groups],
  );
  const channelGroup = useMemo(
    () => capabilitySnapshot.groups.find((group) => group.id === 'channels'),
    [capabilitySnapshot.groups],
  );
  const runsSupported = useMemo(
    () =>
      connected && capabilitySnapshot.groups.find((group) => group.id === 'agent')?.status === 'ready',
    [connected, capabilitySnapshot.groups],
  );

  // Empty-home discovered rows reuse Gate setup's add + connect + open-chat path.
  const handleAddDiscovered = useCallback(
    async (beaconId: string) => {
      const beacon = discovery.gateways.find((item) => item.id === beaconId);
      if (!beacon) return;
      const profile = await addGateway({
        name: beacon.name,
        url: beacon.url,
        tlsFingerprint: beacon.tlsFingerprint,
        discoverySource: beacon.source === 'local' ? 'local' : 'tailscale',
      });
      await connectGateway(profile);
      router.push('/chat');
    },
    [addGateway, connectGateway, discovery.gateways, router],
  );

  // One surface rule: with nothing saved yet this component is STILL the home
  // screen — the hero slot becomes the connect empty state (HomeStatusCard)
  // and pairing/troubleshooting/setup hang directly off it, instead of the
  // screen forking between two different bodies.
  if (gateways.length === 0) {
    const model = describeHomeEmptyState({
      status,
      connectionPhase,
      lastError,
      deviceId,
      tailscaleHost: settings.tailscaleHost,
      discoveredCount: discovery.gateways.length,
    });
    return (
      <>
        <HomeStatusCard
          pcName={settings.pcName}
          phase={connectionPhase}
          status={status}
          statusDetail={statusDetail}
          probeMessage={probeMessage}
          autoRetryNote={autoRetry ? describeAutoRetry(autoRetry) : undefined}
          onConnect={() => void retryAutoConnect()}
          onOpenChat={() => router.push('/chat')}
        />

        {model.showPairing && deviceId ? (
          <PairingPanel deviceId={deviceId} pairingDetails={pairingDetails} />
        ) : null}

        {model.showTroubleshooting ? (
          <GlassCollapsible title="Troubleshooting">
            <Text color="secondary">
              - Hermes (or Gate) listening on the PC{'\n'}- API key matches API_SERVER_KEY (or Gate token)
              {'\n'}- Phone and PC on the same Tailscale tailnet{'\n'}- Tailscale Serve / LAN URL reachable from
              the phone{'\n'}- If Hermes reports running but nothing answers: restart the gateway on the PC
            </Text>
            <Text variant="caption" color="tertiary">
              {describeGatewayError(lastError)}
            </Text>
          </GlassCollapsible>
        ) : null}

        {model.showDiscovered ? (
          <GlassCollapsible title="Found on your network">
            <Text color="secondary">
              {discovery.gateways.length} gateway{discovery.gateways.length === 1 ? '' : 's'} nearby - Versutus
              will use them automatically when connecting.
            </Text>
            {discovery.gateways.map((gateway) => (
              <DiscoveredGatewayRow
                key={gateway.id}
                gateway={gateway}
                isScanning={discovery.status === 'scanning'}
                onAdd={handleAddDiscovered}
              />
            ))}
          </GlassCollapsible>
        ) : null}

        {model.showSetupAction ? (
          <Link href="/onboarding" asChild>
            <Button label={model.setupLabel} variant="secondary" />
          </Link>
        ) : null}
      </>
    );
  }

  const activeLabel = activeGateway?.name ?? 'No active gateway';
  const primaryActions = homeHeroPrimaryActions();
  const orbColor = statusColor(tokens, status);
  const statusLabel = connected
    ? 'Connected'
    : status === 'connecting' || status === 'reconnecting'
      ? 'Connecting'
      : status === 'pairing'
        ? 'Needs approval'
        : 'Disconnected';

  function confirmDelete(gateway: GatewayProfile) {
    setDeleteCandidate(gateway);
  }

  function executeDelete() {
    if (deleteCandidate) {
      void deleteGateway(deleteCandidate.id);
    }
    setDeleteCandidate(null);
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
          <PressableScale
            onPress={() => setStatusExpanded((prev) => !prev)}
            hitSlop={CHIP_HIT_SLOP}
            accessibilityRole="button"
            accessibilityState={{ expanded: statusExpanded }}
            accessibilityLabel={
              statusExpanded ? 'Collapse connection failure detail' : 'Expand connection failure detail'
            }>
            <Text variant="caption" numberOfLines={statusExpanded ? undefined : 3} style={styles.onGlassTertiary}>
              {statusDetail}
            </Text>
          </PressableScale>
        ) : null}

        {!connected && autoRetry ? (
          <PressableScale
            onPress={() => setRetryExpanded((prev) => !prev)}
            hitSlop={CHIP_HIT_SLOP}
            accessibilityRole="button"
            accessibilityState={{ expanded: retryExpanded }}
            accessibilityLabel={
              retryExpanded ? 'Collapse auto-retry schedule' : 'Expand auto-retry schedule'
            }>
            <Text variant="caption" numberOfLines={retryExpanded ? undefined : 2} style={styles.onGlassTertiary}>
              {describeAutoRetry(autoRetry)}
            </Text>
          </PressableScale>
        ) : null}

        {lastError ? (
          <ErrorCard
            {...humanizeGatewayError(lastError)}
            retryLabel="Retry"
            onRetry={() => void retryAutoConnect()}
          />
        ) : null}

        {primaryActions.length > 0 ? (
          <View style={styles.primaryActions}>
            {primaryActions.map((action) => (
              <Button
                key={action.id}
                label={action.label}
                onPress={async () => {
                  await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  router.push(action.href as Href);
                }}
                disabled={!connected}
                variant="secondary"
                style={styles.primaryAction}
              />
            ))}
          </View>
        ) : null}
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

      {/* Channels stay on the first screen even when healthy — when a declaring
          gateway reports degraded bridges, the row itself carries the verdict. */}
      <ChannelStatusRow
        group={channelGroup}
        onPress={async () => {
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          router.push('/chat');
        }}
      />

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

      <HomeBriefingCard />

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

      <HealthChecksPane />
      <PairedDevicesPane />

      <CapabilityHive groups={capabilitySnapshot.groups} status={capabilitySnapshot.status} />
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

      <ConfirmSheet
        visible={deleteCandidate !== null}
        title="Remove gateway?"
        message={`${deleteCandidate?.name ?? 'This gateway'} will stay available if discovered again.`}
        confirmLabel="Remove"
        danger
        onCancel={() => setDeleteCandidate(null)}
        onConfirm={executeDelete}
      />
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
    minHeight: 44,
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
