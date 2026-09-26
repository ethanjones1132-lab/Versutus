import { DrawerMenuButton } from '@/components/nav/drawer-menu-button';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Platform, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AgentTargets } from '@/components/activity/agent-targets';
import { ApprovalDecisionCard } from '@/components/activity/approval-decision-card';
import { ApprovalInbox } from '@/components/activity/approval-inbox';
import { CronSection } from '@/components/activity/cron-section';
import { SpendEntryRow } from '@/components/gateway/spend-entry-row';
import { Badge, Button, Card, ErrorCard, Screen, Skeleton, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useTokens } from '@/hooks/use-tokens';
import { useAmbientParallaxScroll } from '@/lib/motion/ambient-parallax';
import { screenEdgesFor } from '@/lib/motion/screen-edges';
import { tabContentPaddingBottom } from '@/lib/motion/tab-insets';
import {
  approvalAuditCopy,
  loadApprovalAuditStrict,
  type ApprovalAuditEntry,
} from '@/lib/gateway/approval-policy';
import {
  approvalAuditRecent,
  approvalAuditTallyCopy,
} from '@/lib/gateway/approval-audit-view';

/**
 * The scheduled-work view. Workflows slice 3b extracted the individual run
 * surface (the start card, the windowed run list and the post-run scorecards)
 * to its own `/runs` destination; this tab keeps the gateway's cron jobs, the
 * pending approval and the gateway-wide reads, with one control into Runs.
 */
export default function ActivityScreen() {
  const router = useRouter();
  const tokens = useTokens();
  const {
    activeGateway,
    gateways,
    status,
    pendingRunApproval,
    resolveRunApproval,
    refreshPendingApprovals,
    connectGateway,
    refreshCapabilities,
    refreshGateways,
  } = useGateway();

  const [refreshing, setRefreshing] = useState(false);
  // A refused refresh read is named below the header instead of ending the
  // spinner as if the pull succeeded; cleared by the next success.
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // A pull-to-refresh re-reads capabilities + gateways but not cron jobs
  // (CronSection loads once per connection); bumping this signal reaches
  // the section's re-list without remounting the tab.
  const [cronReloadSignal, setCronReloadSignal] = useState(0);
  // Decision history is this device's key-value audit, not a Gateway read:
  // loaded once, and re-read alongside the pulls so a fresh decision shows.
  // Three phases, because the lenient loader folds a storage refusal into []
  // and an in-flight read also starts empty — both would otherwise print
  // "No approval decisions recorded…" as if the log were genuinely empty.
  const [audit, setAudit] = useState<ApprovalAuditEntry[]>([]);
  const [auditState, setAuditState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [auditError, setAuditError] = useState<string | null>(null);
  const { parallaxY, onScroll } = useAmbientParallaxScroll();
  const insets = useSafeAreaInsets();

  // One reader for mount, retry, and pull-to-refresh: the strict loader
  // rejects on a storage refusal so `failed` is reachable, and `isLive`
  // keeps an unmounted tab from taking the late answer.
  const readAudit = useCallback(async (isLive?: () => boolean): Promise<void> => {
    setAuditState('loading');
    setAuditError(null);
    try {
      const entries = await loadApprovalAuditStrict();
      if (isLive && !isLive()) return;
      setAudit(entries);
      setAuditState('ready');
    } catch (caught) {
      if (isLive && !isLive()) return;
      setAuditError(caught instanceof Error ? caught.message : String(caught));
      setAuditState('failed');
    }
  }, []);

  // Loaded once on mount, and re-read alongside each pull-to-refresh so a
  // fresh decision shows without waiting for the next visit. Deferred one
  // tick like CronSection's mount read, so the loading flip is not a
  // synchronous setState in the effect body.
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void readAudit(() => live);
    }, 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [readAudit]);

  const onRefresh = async () => {
    setRefreshing(true);
    const started = Date.now();
    try {
      await Promise.all([refreshCapabilities(), refreshGateways(), refreshPendingApprovals()]);
      setRefreshError(null);
    } catch (caught) {
      setRefreshError(caught instanceof Error ? caught.message : String(caught));
    }
    await readAudit();
    setCronReloadSignal((n) => n + 1);
    // Hold the spinner briefly so recovery isn't a disorienting flash.
    const elapsed = Date.now() - started;
    if (elapsed < 400) await new Promise((resolve) => setTimeout(resolve, 400 - elapsed));
    setRefreshing(false);
  };

  return (
    <Screen edges={screenEdgesFor({ platform: Platform.OS, hasDock: true })} parallaxY={parallaxY}>
      <ScrollView
        style={styles.list}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: tabContentPaddingBottom({ platform: Platform.OS, insetBottom: insets.bottom }) },
        ]}
        onScroll={onScroll}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={tokens.accent}
            colors={[tokens.accent]}
            progressBackgroundColor={tokens.backgroundElevated}
          />
        }>
        <View style={styles.header}>
          <View style={styles.titleRow}>
            <DrawerMenuButton />
            <View style={styles.titleText}>
              <Text variant="title">Activity</Text>
            </View>
            <Badge
              label={status === 'connected' ? 'Live' : 'Offline'}
              tone={status === 'connected' ? 'success' : 'neutral'}
            />
          </View>

          {refreshError ? (
            <ErrorCard
              cause={refreshError}
              affected="Activity's gateway reads"
              next="Retry the refresh."
              onRetry={() => void onRefresh()}
              onDismiss={() => setRefreshError(null)}
            />
          ) : null}

          {/* Workflows slice 3b: runs have their own destination, so this is
              the scheduled-work view rather than a run list. */}
          <Card variant="inset" padding={Spacing.three} style={styles.runsEntryCard}>
            <Text variant="body" color="secondary">
              Scheduled work is here. Individual runs have their own screen.
            </Text>
            <Button
              label="Open runs"
              variant="ghost"
              size="sm"
              onPress={() => router.push('/runs')}
            />
          </Card>

          {/* D1: the Gate's pending approvals, triaged without the run open. */}
          <ApprovalInbox />

          {/* D1: what this device has already decided — the tally plus the
              newest lines. Settings keeps the full history. Loading shows
              placeholders (never the empty tally); a refused read shows an
              inline retry instead of inventing an empty log. */}
          <Card variant="inset" padding={Spacing.three} style={styles.card}>
            <Text variant="headline">Approval decisions</Text>
            {auditState === 'loading' ? (
              <>
                <Skeleton width="72%" height={14} />
                <Skeleton width="90%" height={12} />
                <Skeleton width="64%" height={12} />
              </>
            ) : null}
            {auditState === 'failed' ? (
              <ErrorCard
                cause={auditError ?? 'Decision history could not be read.'}
                affected="Approval decisions on this device"
                next="Retry the read."
                onRetry={() => void readAudit()}
              />
            ) : null}
            {auditState === 'ready' ? (
              <>
                <Text variant="caption" color="secondary">
                  {approvalAuditTallyCopy(audit)}
                </Text>
                {approvalAuditRecent(audit, 4).map((record) => (
                  <Text key={`${record.approvalId}-${record.at}`} variant="micro" color="tertiary">
                    {approvalAuditCopy(record)}
                  </Text>
                ))}
              </>
            ) : null}
          </Card>

          {pendingRunApproval ? (
            <ApprovalDecisionCard
              runId={pendingRunApproval.runId}
              prompt={pendingRunApproval.prompt}
              onResolve={(approved, feedback) => resolveRunApproval(approved, feedback)}
            />
          ) : null}
        </View>

      <View style={styles.footer}>
      <CronSection cronReloadSignal={cronReloadSignal} />

      {/* Spend is the gateway-wide readout, so it sits with the gateway-wide
          work. Renders nothing while no connection can answer it. */}
      <SpendEntryRow />

      <AgentTargets
        gateways={gateways}
        activeGatewayId={activeGateway?.id}
        status={status}
        onSelect={(gateway) => {
          void connectGateway(gateway);
        }}
      />
      </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.four,
    gap: Spacing.three,
    flexGrow: 1,
  },
  header: {
    gap: Spacing.three,
  },
  footer: {
    gap: Spacing.three,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  titleText: {
    flex: 1,
  },
  card: { gap: Spacing.two },
  runsEntryCard: {
    gap: Spacing.two,
  },
});
