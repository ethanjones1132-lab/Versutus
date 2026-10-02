import { DrawerMenuButton } from '@/components/nav/drawer-menu-button';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Platform, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ActivityGlance } from '@/components/activity/activity-glance';
import { AgentTargets } from '@/components/activity/agent-targets';
import { ApprovalDecisionCard } from '@/components/activity/approval-decision-card';
import { ApprovalInbox } from '@/components/activity/approval-inbox';
import { CronSection } from '@/components/activity/cron-section';
import { SpendEntryRow } from '@/components/gateway/spend-entry-row';
import { RecentRuns } from '@/components/activity/recent-runs';
import { PulsingDot } from '@/components/connection-badge';
import { Card, ErrorCard, Icon, PageTitle, Screen, SectionHeader, Skeleton, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useNow } from '@/hooks/use-now';
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
    activityRunsForActiveGateway,
    gateways,
    settings,
    status,
    pendingRunApproval,
    pendingApprovals,
    requestRunFocus,
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
  // A pull-to-refresh re-reads the gateway reads above and signals the cron
  // section to re-list; bumping this signal reaches the section's re-list
  // without remounting the tab, and the section coalesces it with a read
  // already in flight.
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
  // The glance's "now": a minute is as fine as a day-long ribbon can show.
  const now = useNow(60_000);
  // Any run on Activity opens Runs *on that run*: the same door a run
  // notice uses, so Runs finds it, scrolls to it and lights its edge.
  const openRun = useCallback(
    (runId: string) => {
      requestRunFocus({ runId });
      router.push('/runs');
    },
    [requestRunFocus, router],
  );

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
      // Sequentially, in the order the tab is actually read: the approvals are
      // what Activity is opened for, then what the gateway can do, then the
      // local roster. Fanned out in one `Promise.all` these three went to a
      // host the repo documents as serving one request at a time, so the
      // spinner waited on a concurrent pile rather than on the work.
      await refreshPendingApprovals();
      await refreshCapabilities();
      await refreshGateways();
      setRefreshError(null);
    } catch (caught) {
      setRefreshError(caught instanceof Error ? caught.message : String(caught));
    }
    await readAudit();
    // The section's own `load` coalesces with a read already in flight, so
    // this bump costs at most the one read that is still running.
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
          <PageTitle
            title="Activity"
            leading={<DrawerMenuButton />}
            status={
              <>
                <PulsingDot
                  color={status === 'connected' ? tokens.statusConnected : tokens.textTertiary}
                  active={status === 'connecting' || status === 'reconnecting'}
                />
                <Text variant="caption" color="secondary">
                  {status === 'connected'
                    ? `Live${activeGateway ? ` · ${settings.pcName ?? activeGateway.name}` : ''}`
                    : 'Offline — showing what this phone last saw'}
                </Text>
              </>
            }
          />

          {/* The day at a glance: three figures, and the last day's runs as a
              ribbon of light in their Bots' colours. */}
          <ActivityGlance
            pendingApprovals={pendingApprovals.length}
            runs={activityRunsForActiveGateway}
            now={now}
            onOpenRuns={() => router.push('/runs')}
            onOpenRun={openRun}
          />

          {refreshError ? (
            <ErrorCard
              cause={refreshError}
              affected="Activity's gateway reads"
              next="Retry the refresh."
              onRetry={() => void onRefresh()}
              onDismiss={() => setRefreshError(null)}
            />
          ) : null}

          {/* D1: the Gate's pending approvals, triaged without the run open. */}
          <View style={styles.section}>
            <SectionHeader title="Needs you" />
            <ApprovalInbox />
          </View>

          {pendingRunApproval ? (
            <ApprovalDecisionCard
              runId={pendingRunApproval.runId}
              prompt={pendingRunApproval.prompt}
              onResolve={(approved, feedback) => resolveRunApproval(approved, feedback)}
            />
          ) : null}

          {/* Workflows slice 3b: runs have their own destination; this is the
              glance — what is waiting, what is working, what just finished. */}
          <View style={styles.section}>
            <SectionHeader title="Runs" actionLabel="See all" onAction={() => router.push('/runs')} />
            <RecentRuns runs={activityRunsForActiveGateway} onOpenRun={openRun} />
          </View>
        </View>

      <View style={styles.footer}>
      <CronSection cronReloadSignal={cronReloadSignal} />

      {/* D1: what this device has already decided — the tally plus the
          newest lines. Settings keeps the full history. Loading shows
          placeholders (never the empty tally); a refused read shows an
          inline retry instead of inventing an empty log. */}
      <View style={styles.section}>
        <SectionHeader title="Your decisions" />
        {auditState === 'loading' ? (
          <Card variant="stage" padding={Spacing.three} style={styles.card}>
            <Skeleton width="72%" height={14} />
            <Skeleton width="90%" height={12} />
            <Skeleton width="64%" height={12} />
          </Card>
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
          audit.length === 0 ? (
            // Nothing decided yet is a quiet line, not a box holding a sentence.
            <View style={styles.quiet}>
              <Icon name={{ ios: 'checkmark.seal', android: 'verified', web: 'verified' }} size={15} color="textTertiary" />
              <Text variant="caption" color="tertiary" style={styles.quietText}>
                {approvalAuditTallyCopy(audit)}
              </Text>
            </View>
          ) : (
            <Card variant="stage" padding={Spacing.three} style={styles.card}>
              <Text variant="body">{approvalAuditTallyCopy(audit)}</Text>
              {approvalAuditRecent(audit, 4).map((record) => (
                <Text key={`${record.approvalId}-${record.at}`} variant="caption" color="tertiary">
                  {approvalAuditCopy(record)}
                </Text>
              ))}
            </Card>
          )
        ) : null}
      </View>

      {/* Spend is the gateway-wide readout, so it sits with the gateway-wide
          work. Renders nothing while no connection can answer it. */}
      <SpendEntryRow />

      <View style={styles.section}>
        <SectionHeader title="Gateways" />
        <AgentTargets
          gateways={gateways}
          activeGatewayId={activeGateway?.id}
          status={status}
          onSelect={(gateway) => {
            // `connectGateway` rethrows an auth refusal by design and this action
            // is fire-and-forget, so without a handler a refused key was an
            // unhandled rejection with nothing on screen. The refresh notice is
            // the screen's one error line, and the provider has already written
            // the same reason into `lastError`.
            void connectGateway(gateway).catch((caught: unknown) => {
              setRefreshError(caught instanceof Error ? caught.message : String(caught));
            });
          }}
        />
      </View>
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
    paddingHorizontal: Spacing.four - 4,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.four,
    gap: Spacing.four,
    flexGrow: 1,
  },
  header: {
    gap: Spacing.four,
  },
  footer: {
    gap: Spacing.four,
  },
  section: {
    gap: Spacing.two,
  },
  card: { gap: Spacing.two },
  quiet: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.two,
  },
  quietText: { flex: 1 },
});
