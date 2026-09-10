import * as Haptics from 'expo-haptics';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, RefreshControl, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ComposerKeyboardLift } from '@/components/layout/ComposerKeyboardLift';
import { activityKeyboardBehavior } from '@/lib/activity/keyboard-behavior';

import { AgentTargets } from '@/components/activity/agent-targets';
import { AgenticRunSheet } from '@/components/activity/agentic-run-sheet';
import { ApprovalDecisionCard } from '@/components/activity/approval-decision-card';
import { CronSection } from '@/components/activity/cron-section';
import { RunCard } from '@/components/activity/run-card';
import { ScorecardsSection } from '@/components/activity/scorecards-section';
import { SpendEntryRow } from '@/components/gateway/spend-entry-row';
import { Badge, Button, Card, EmptyState, Screen, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useTokens } from '@/hooks/use-tokens';
import { filterRunsByBot, type ScorecardFilter } from '@/lib/fleet/scorecard';
import { useAmbientParallaxScroll } from '@/lib/motion/ambient-parallax';
import { screenEdgesFor } from '@/lib/motion/screen-edges';
import { tabContentPaddingBottom } from '@/lib/motion/tab-insets';
import type { CronJob } from '@/lib/gateway/cron';
import type { ActivityRun } from '@/lib/gateway/runs';

type ActivityItem =
  | { kind: 'label'; id: string; text: string }
  | { kind: 'active'; id: string; run: ActivityRun }
  | { kind: 'finished'; id: string; run: ActivityRun };

export default function ActivityScreen() {
  const tokens = useTokens();
  const {
    activeGateway,
    gateways,
    status,
    activityRuns,
    stopActivityRun,
    pendingRunApproval,
    resolveRunApproval,
    connectGateway,
    capabilitySnapshot,
    refreshCapabilities,
    refreshGateways,
    sendChatInput,
    loadRunEvents,
    requestedRunFocus,
    clearRequestedRunFocus,
    cron,
  } = useGateway();

  const [runPrompt, setRunPrompt] = useState('');
  const [starting, setStarting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // A pull-to-refresh re-reads capabilities + gateways but not cron jobs
  // (CronSection loads once per connection); bumping this signal reaches
  // the section's re-list without remounting the tab.
  const [cronReloadSignal, setCronReloadSignal] = useState(0);
  // The gateway's own job list, so a card can carry its Bot's routine health.
  // A gateway that cannot report cron, or a read that fails, leaves it empty
  // and every card with no routine line rather than a claim about work nothing
  // read — and this read never adds a card: the cards stay the runs this
  // device holds.
  const [routineJobs, setRoutineJobs] = useState<CronJob[]>([]);
  // A tapped "View transcript" on a finished run card opens the sheet keyed on
  // the run id; null closes. The sheet keys itself on the id, so a different
  // run arrives as a fresh component with empty state.
  const [openAgenticRunId, setOpenAgenticRunId] = useState<string | null>(null);
  // The Scorecards section's tap: the bucket the run list is filtered to, or
  // null for no filter. Null is the default and passes the provider's list
  // through untouched, so the tab opens exactly as it did before scorecards.
  const [scorecardFilter, setScorecardFilter] = useState<ScorecardFilter>(null);
  const { parallaxY, onScroll } = useAmbientParallaxScroll();
  const insets = useSafeAreaInsets();

  // A run notice's tap names a run, and the list can be filtered to another Bot
  // at that moment (a scorecard tap's filter is sticky state on this tab). The
  // filter goes, so the run the notice was about is not hidden behind a Bot it
  // never belonged to — and only the filter: a run this device does not hold has
  // no row to reach, so nothing here selects one the read cannot prove is there.
  // Deferred a tick like every other state write from an effect in this repo,
  // and the request is retired with it so it cannot fight the operator's own
  // next navigation.
  useEffect(() => {
    if (!requestedRunFocus) return undefined;
    const timer = setTimeout(() => {
      setScorecardFilter(null);
      clearRequestedRunFocus();
    }, 0);
    return () => clearTimeout(timer);
  }, [requestedRunFocus, clearRequestedRunFocus]);

  const visibleRuns = useMemo(
    () => filterRunsByBot(activityRuns, scorecardFilter),
    [activityRuns, scorecardFilter],
  );
  const activeRuns = visibleRuns.filter((run) => run.status === 'running' || run.status === 'waiting-approval');
  const finishedRuns = visibleRuns.filter((run) => !activeRuns.includes(run));
  const runsSupported =
    status === 'connected' &&
    capabilitySnapshot.groups.find((group) => group.id === 'agent')?.status === 'ready';
  const runsUnsupported =
    status === 'connected' &&
    capabilitySnapshot.groups.find((group) => group.id === 'agent')?.status === 'unsupported';

  const startRun = async () => {
    const prompt = runPrompt.trim();
    if (!prompt || !runsSupported || starting) return;
    setStarting(true);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      // Route through slash so Activity + chat command bubble stay consistent.
      // Clear the draft only when the command completed: a refusal still
      // lands its "Command failed" bubble in chat, and the prompt stays so
      // the operator can fix and resend instead of retyping it.
      const outcome = await sendChatInput(`/run ${prompt}`);
      if (outcome === 'complete') setRunPrompt('');
    } finally {
      setStarting(false);
    }
  };

  // A failed / cancelled / unresolved run card surfaces a "Retry run" button
  // that re-runs the same prompt through the `/run` slash command, the same
  // path the Start-a-run card uses. No confirmation: the slash command is
  // `danger: 'safe'` (dashboard.ts:600) so re-running is the same kind of
  // action as starting a new run from chat — the activity card just skips the
  // intermediate step of re-pasting the prompt.
  const retryRun = useCallback(
    (run: ActivityRun) => {
      const prompt = run.prompt.trim();
      if (!prompt) return;
      void sendChatInput(`/run ${prompt}`);
    },
    [sendChatInput],
  );

  const onRefresh = async () => {
    setRefreshing(true);
    const started = Date.now();
    await Promise.all([refreshCapabilities(), refreshGateways()]).catch(() => undefined);
    setCronReloadSignal((n) => n + 1);
    // Hold the spinner briefly so recovery isn't a disorienting flash.
    const elapsed = Date.now() - started;
    if (elapsed < 400) await new Promise((resolve) => setTimeout(resolve, 400 - elapsed));
    setRefreshing(false);
  };

  // The gateway's own jobs, read for the scorecards' routine line. CronSection
  // reads the roster for its own list; this read exists because a card carries
  // a Bot's routine health beside its runs, and both hang off the same two
  // edges — a return to the tab (focus) and a pull-to-refresh, which bumps the
  // same signal that re-lists the cron section.
  const loadRoutineJobs = useCallback(() => {
    let live = true;
    const read =
      status === 'connected' && cron.available
        ? cron.list().catch(() => [] as CronJob[])
        : Promise.resolve<CronJob[]>([]);
    void read.then((jobs) => {
      if (live) setRoutineJobs(jobs);
    });
    return () => {
      live = false;
    };
  }, [cron, status]);

  useFocusEffect(loadRoutineJobs);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadRoutineJobs();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadRoutineJobs, cronReloadSignal]);

  // One windowed list carries both run sections so a gateway with a long run
  // history lays out only the few cards on screen, not hundreds at once.
  const listData = useMemo<ActivityItem[]>(() => {
    const items: ActivityItem[] = [];
    if (activeRuns.length > 0) {
      items.push({ kind: 'label', id: 'in-flight', text: 'In flight' });
      for (const run of activeRuns) items.push({ kind: 'active', id: run.id, run });
    }
    if (finishedRuns.length > 0) {
      items.push({ kind: 'label', id: 'recent', text: 'Recent runs' });
      for (const run of finishedRuns) items.push({ kind: 'finished', id: run.id, run });
    }
    return items;
  }, [activeRuns, finishedRuns]);

  const renderItem = useCallback(
    ({ item }: { item: ActivityItem }) => {
      switch (item.kind) {
        case 'label':
          return (
            <Text variant="caption" color="secondary" style={styles.sectionTitle}>
              {item.text}
            </Text>
          );
        case 'active':
          return <RunCard run={item.run} onStop={stopActivityRun} />;
        case 'finished':
          return (
            <RunCard
              run={item.run}
              onOpenTranscript={setOpenAgenticRunId}
              onRetry={(prompt) => retryRun({ ...item.run, prompt })}
            />
          );
      }
    },
    [stopActivityRun, retryRun],
  );

  const listHeader = (
    <View style={styles.header}>
      <View style={styles.titleRow}>
        <Text variant="title">Activity</Text>
        <Badge
          label={status === 'connected' ? 'Live' : 'Offline'}
          tone={status === 'connected' ? 'success' : 'neutral'}
        />
      </View>

      {pendingRunApproval ? (
        <ApprovalDecisionCard
          runId={pendingRunApproval.runId}
          prompt={pendingRunApproval.prompt}
          onResolve={(approved, feedback) => resolveRunApproval(approved, feedback)}
        />
      ) : null}

      {runsSupported
        ? (() => {
            const startCard = (
              <Card padding={Spacing.three} style={styles.startCard}>
                <Text variant="caption" color="accentWarm" style={styles.approvalEyebrow}>
                  Start a run
                </Text>
                <Text variant="body" color="secondary">
                  Agentic task with live events and approval gates. Tracks here while it runs.
                </Text>
                <TextField
                  value={runPrompt}
                  onChangeText={setRunPrompt}
                  placeholder="Describe the task…"
                  multiline
                  // A run prompt is prose — keep the platform typing defaults; the
                  // kit's form defaults (none / no autocorrect) are for URLs and tokens.
                  autoCapitalize="sentences"
                  autoCorrect={true}
                  editable={!starting && status === 'connected'}
                  accessibilityLabel="Run prompt"
                />
                <Button
                  label={starting ? 'Starting…' : 'Run task'}
                  onPress={() => void startRun()}
                  disabled={!runPrompt.trim() || starting || status !== 'connected'}
                  busy={starting}
                />
              </Card>
            );
            const lifted = <ComposerKeyboardLift>{startCard}</ComposerKeyboardLift>;
            if (activityKeyboardBehavior(Platform.OS) === 'padding') {
              return (
                <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={insets.top}>
                  {lifted}
                </KeyboardAvoidingView>
              );
            }
            return lifted;
          })()
        : null}
    </View>
  );

  const listFooter = (
    <View style={styles.footer}>
      {/* Per-Bot track records, folded from the same persisted runs the list
          above renders, with the gateway's own routine health beside them. A
          tapped card filters that list; it folds the whole read, so the cards
          stay whole while the list narrows. */}
      <ScorecardsSection runs={activityRuns} jobs={routineJobs} filter={scorecardFilter} onSelect={setScorecardFilter} />

      {/* Scheduled work sits with live runs: Activity is the one place that
          answers "what is this gateway doing". Renders nothing on a gateway
          that cannot report cron. */}
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

      {activityRuns.length === 0 && !pendingRunApproval ? (
        <EmptyState
          icon={{ ios: 'bolt', android: 'bolt', web: 'bolt' }}
          title={
            !activeGateway
              ? 'Nothing to watch yet'
              : runsUnsupported
                ? 'Runs not offered'
                : status !== 'connected'
                  ? 'Connect to start runs'
                  : 'No runs yet'
          }
          description={
            !activeGateway
              ? 'Connect to a gateway that supports agentic runs, then start one here or with /run in chat.'
              : runsUnsupported
                ? `${activeGateway.name} is chat-only (or has no run API). Chat still works; agentic runs need Hermes /v1/runs.`
                : status !== 'connected'
                  ? 'Reconnect, then start a run from this screen or Chat → overflow → Run task.'
                  : 'Start a run above, use Chat overflow → Run task, or type /run <prompt> in chat.'
          }
          actionLabel={activeGateway && status !== 'connected' ? 'Reconnect' : undefined}
          onAction={
            activeGateway && status !== 'connected'
              ? () => {
                  void connectGateway(activeGateway);
                }
              : undefined
          }
        />
      ) : null}
    </View>
  );

  return (
    <Screen edges={screenEdgesFor({ platform: Platform.OS, hasDock: false })} parallaxY={parallaxY}>
      <FlatList
        data={listData}
        keyExtractor={(item) => item.id}
        style={styles.list}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: tabContentPaddingBottom({ platform: Platform.OS, insetBottom: insets.bottom }) },
        ]}
        onScroll={onScroll}
        scrollEventThrottle={16}
        removeClippedSubviews
        initialNumToRender={12}
        maxToRenderPerBatch={16}
        windowSize={9}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={tokens.accentWarm}
            colors={[tokens.accentWarm]}
            progressBackgroundColor={tokens.backgroundElevated}
          />
        }
        ListHeaderComponent={listHeader}
        ListFooterComponent={listFooter}
        renderItem={renderItem}
      />
      <AgenticRunSheet
        key={openAgenticRunId ?? 'no-run'}
        runId={openAgenticRunId}
        loadEvents={loadRunEvents}
        onClose={() => setOpenAgenticRunId(null)}
      />
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
  approvalEyebrow: {
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  startCard: {
    gap: Spacing.two,
  },
  sectionTitle: {
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
});
