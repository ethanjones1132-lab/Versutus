import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, RefreshControl, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ComposerKeyboardLift } from '@/components/layout/ComposerKeyboardLift';
import { activityKeyboardBehavior } from '@/lib/activity/keyboard-behavior';
import { partitionRunsByState } from '@/lib/activity/run-partition';

import { ActivityGlance } from '@/components/activity/activity-glance';
import { AgenticRunSheet } from '@/components/activity/agentic-run-sheet';
import { PulsingDot } from '@/components/connection-badge';
import { RunCard } from '@/components/activity/run-card';
import { ScorecardsSection } from '@/components/activity/scorecards-section';
import { Button, Card, EmptyState, ErrorCard, Icon, PageTitle, PressableScale, Screen, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useNow } from '@/hooks/use-now';
import { useTokens } from '@/hooks/use-tokens';
import { filterRunsByBot, type ScorecardFilter } from '@/lib/fleet/scorecard';
import { haptics } from '@/lib/haptics';
import { useAmbientParallaxScroll } from '@/lib/motion/ambient-parallax';
import { screenEdgesFor } from '@/lib/motion/screen-edges';
import { tabContentPaddingBottom } from '@/lib/motion/tab-insets';
import type { CronJob } from '@/lib/gateway/cron';
import { readBotSpend, type BotSpendRow } from '@/lib/gateway/spend-report';
import { focusedRunItemId, type RunListItem as ActivityItem } from '@/lib/notifications/run-list-focus';

import type { ActivityRun } from '@/lib/gateway/runs';

/**
 * The individual run surface, extracted from the Activity tab (Workflows slice
 * 3b). Activity is now the scheduled-work view; this destination carries the
 * start-a-run card, the windowed run list and the post-run scorecards, reached
 * from Activity's own "Runs" control and from a run notice.
 */
export default function RunsScreen() {
  const tokens = useTokens();
  const {
    activeGateway,
    status,
    activityRunsForActiveGateway,
    stopActivityRun,
    connectGateway,
    capabilitySnapshot,
    refreshCapabilities,
    refreshGateways,
    sendChatInput,
    loadRunEvents,
    requestedRunFocus,
    requestRunFocus,
    clearRequestedRunFocus,
    pendingApprovals,
    cron,
    listBots,
    readBotSessions,
    canReadBotSessions,
  } = useGateway();

  const [runPrompt, setRunPrompt] = useState('');
  const [starting, setStarting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // A refused refresh read is named below the header instead of ending the
  // spinner as if the pull succeeded; cleared by the next success.
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // A pull-to-refresh re-reads capabilities + gateways and re-reads the two
  // per-Bot folds the scorecards carry (the gateway's jobs and P5's spend).
  // Bumping this signal reaches those reads without remounting the screen.
  const [runsReloadSignal, setRunsReloadSignal] = useState(0);
  // The gateway's own job list, so a card can carry its Bot's routine health.
  // A gateway that cannot report cron, or a read that fails, leaves it empty
  // and every card with no routine line rather than a claim about work nothing
  // read — and this read never adds a card: the cards stay the runs this
  // device holds.
  const [routineJobs, setRoutineJobs] = useState<CronJob[]>([]);
  // P5's per-Bot spend, so a card can carry what its Bot cost. Empty until a
  // read lands — which is also what a refused or failed read leaves, so no
  // card ever claims a spend nobody read.
  const [spendRows, setSpendRows] = useState<BotSpendRow[]>([]);
  // The roster's names, so a scorecard reads "Forge" rather than its id.
  // A failed read leaves the ids, which are still true.
  const [botNames, setBotNames] = useState<Record<string, string>>({});
  // A tapped "View transcript" on a finished run card opens the sheet keyed on
  // the run id; null closes. The sheet keys itself on the id, so a different
  // run arrives as a fresh component with empty state.
  const [openAgenticRunId, setOpenAgenticRunId] = useState<string | null>(null);
  // The Scorecards section's tap: the bucket the run list is filtered to, or
  // null for no filter. Null is the default and passes the provider's list
  // through untouched, so the destination opens exactly as the tab did before.
  const [scorecardFilter, setScorecardFilter] = useState<ScorecardFilter>(null);
  const { parallaxY, onScroll } = useAmbientParallaxScroll();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const now = useNow(60_000);
  const listRef = useRef<FlatList<ActivityItem>>(null);

  // A run notice's tap names a run, and the list may be filtered to another Bot
  // at that moment (a scorecard tap's filter is sticky state on this screen).
  // The filter goes, so the run the notice was about is not hidden behind a Bot
  // it never belonged to — and only the filter: a run this device does not hold
  // has no row to reach, so nothing here selects one the read cannot prove is
  // there. The row that IS there is highlighted (`focusedRunItemId`): the
  // notice promised the run, not merely its list. Deferred a tick like every
  // other state write from an effect in this repo, and the request is retired
  // with it so it cannot fight the operator's own next navigation.
  const [focusedRunId, setFocusedRunId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ runId: string } | null>(null);

  // The FIRST tick retires the request and asks for the highlight: the filter
  // drop and the focus ask are one operator intent, and both defer out of the
  // effect body the same way. The id itself is checked in the second tick
  // (below), against the folded rows once the filter drop has landed.
  useEffect(() => {
    if (!requestedRunFocus) return undefined;
    const timer = setTimeout(() => {
      setScorecardFilter(null);
      setFocusRequest({ runId: requestedRunFocus.runId });
      clearRequestedRunFocus();
    }, 0);
    return () => clearTimeout(timer);
  }, [requestedRunFocus, clearRequestedRunFocus]);

  const visibleRuns = useMemo(
    () => filterRunsByBot(activityRunsForActiveGateway, scorecardFilter),
    [activityRunsForActiveGateway, scorecardFilter],
  );
  // One partition, once per change to the visible rows — the screen's two
  // lists fold from the same pass instead of two filters over the array,
  // `finishedRuns` without an O(n) membership scan per row.
  const { inFlightRuns: activeRuns, finishedRuns } = useMemo(
    () => partitionRunsByState(visibleRuns),
    [visibleRuns],
  );

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
    try {
      // Inside the try so nothing between here and the send can skip the
      // `finally` and wedge the card on "Starting…". The wrapper cannot
      // reject; the ordering is the guarantee.
      await haptics.medium();
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
  // action as starting a new run from chat — the run card just skips the
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
    try {
      await Promise.all([refreshCapabilities(), refreshGateways()]);
      setRefreshError(null);
    } catch (caught) {
      setRefreshError(caught instanceof Error ? caught.message : String(caught));
    }
    setRunsReloadSignal((n) => n + 1);
    // Hold the spinner briefly so recovery isn't a disorienting flash.
    const elapsed = Date.now() - started;
    if (elapsed < 400) await new Promise((resolve) => setTimeout(resolve, 400 - elapsed));
    setRefreshing(false);
  };

  // The gateway's own jobs, read for the scorecards' routine line. Both hang
  // off the same two edges — a return to the screen (focus) and a
  // pull-to-refresh, which bumps the same signal.
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
  }, [loadRoutineJobs, runsReloadSignal]);

  // P5's per-Bot spend, read for the cards' spend line: the read is the Spend
  // screen's own (`readBotSpend`), so a card and that screen word one read the
  // same way. It hangs off the same two edges as the job list above, and the
  // scoped read joins the source only when the client advertises it — a gateway
  // that could only refuse is never asked. A refused or failed read leaves no
  // rows, so every card says nothing about spend rather than a zero nobody read.
  const loadBotSpend = useCallback(() => {
    let live = true;
    const read =
      status === 'connected'
        ? readBotSpend(canReadBotSessions ? { listBots, readBotSessions } : { listBots })
            .then((report) => report.rows)
            .catch(() => [] as BotSpendRow[])
        : Promise.resolve<BotSpendRow[]>([]);
    void read.then((rows) => {
      if (live) setSpendRows(rows);
    });
    return () => {
      live = false;
    };
  }, [status, canReadBotSessions, listBots, readBotSessions]);

  useFocusEffect(loadBotSpend);

  useEffect(() => {
    if (status !== 'connected') return undefined;
    let live = true;
    void listBots()
      .then((bots) => {
        if (live) setBotNames(Object.fromEntries(bots.map((bot) => [bot.id, bot.displayName])));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [listBots, status]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadBotSpend();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadBotSpend, runsReloadSignal]);

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

  // The highlight fold reads the list rows this screen already folds, so a
  // highlighted id is by construction an id a row actually carries, never a
  // guess. It runs in a second tick (the first retired the request and dropped
  // the filter, above), so the id is checked against the folded rows once that
  // filter drop has landed. A run the list does not hold highlights nothing;
  // the filter drop and the open have already happened, and that is still the
  // honest answer.
  useEffect(() => {
    if (!focusRequest) return undefined;
    const timer = setTimeout(() => {
      setFocusedRunId(focusedRunItemId(listData, focusRequest));
      setFocusRequest(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [focusRequest, listData]);

  // A focused run is not only lit but brought into view: the operator tapped
  // it on Activity (or a notice named it) and should land on it.
  useEffect(() => {
    if (!focusedRunId) return undefined;
    const index = listData.findIndex((item) => item.id === focusedRunId);
    if (index < 0) return undefined;
    const timer = setTimeout(() => {
      listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.15 });
    }, 250);
    return () => clearTimeout(timer);
  }, [focusedRunId, listData]);

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
          return <RunCard run={item.run} highlighted={item.id === focusedRunId} onStop={stopActivityRun} />;
        case 'finished':
          return (
            <RunCard
              run={item.run}
              highlighted={item.id === focusedRunId}
              onOpenTranscript={setOpenAgenticRunId}
              onRetry={(prompt) => retryRun({ ...item.run, prompt })}
            />
          );
      }
    },
    [stopActivityRun, retryRun, focusedRunId],
  );

  const listHeader = (
    <View style={styles.header}>
      {/* Runs opens the way Activity does — the serif title in the lamp's
          light, one status line, and the same day as a ribbon of light — so it
          reads as Activity, opened out, not a different screen. */}
      <PageTitle
        title="Runs"
        leading={
          <PressableScale
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/activity'))}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Back to Activity"
            style={styles.back}>
            <Icon name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={20} color="textPrimary" />
          </PressableScale>
        }
        status={
          <>
            <PulsingDot
              color={status === 'connected' ? tokens.statusConnected : tokens.textTertiary}
              active={status === 'connecting' || status === 'reconnecting'}
            />
            <Text variant="caption" color="secondary">
              {status === 'connected'
                ? `Live${activeRuns.length > 0 ? ` · ${activeRuns.length} in flight` : ''}`
                : 'Offline — showing what this phone last saw'}
            </Text>
          </>
        }
      />

      <ActivityGlance
        pendingApprovals={pendingApprovals.length}
        runs={activityRunsForActiveGateway}
        now={now}
        onOpenRuns={() => setScorecardFilter(null)}
        onOpenRun={(runId) => requestRunFocus({ runId })}
      />

      {refreshError ? (
        <ErrorCard
          cause={refreshError}
          affected="Runs' gateway reads"
          next="Retry the refresh."
          onRetry={() => void onRefresh()}
          onDismiss={() => setRefreshError(null)}
        />
      ) : null}

      {runsSupported
        ? (() => {
            const startCard = (
              <Card variant="stage" padding={Spacing.three} style={styles.startCard}>
                <Text variant="headline">Start a run</Text>
                <Text variant="caption" color="secondary">
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
      {/* With zero runs the list body is empty, so this footer is the whole
          surface below the Start-a-run card — the EmptyState is the screen's
          primary message and leads; the Scorecards section (weekly opt-in,
          empty window copy) follows it rather than burying it. */}
      {activityRunsForActiveGateway.length === 0 ? (
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

      {/* Per-Bot track records, folded from the same persisted runs the list
          above renders, with the gateway's own routine health and P5's spend
          beside them. A tapped card filters that list; it folds the whole
          read, so the cards stay whole while the list narrows. */}
      <ScorecardsSection runs={activityRunsForActiveGateway} jobs={routineJobs} spendRows={spendRows} filter={scorecardFilter} onSelect={setScorecardFilter} botNames={botNames} />
    </View>
  );

  return (
    <Screen edges={screenEdgesFor({ platform: Platform.OS, hasDock: true })} parallaxY={parallaxY}>
      <FlatList
        ref={listRef}
        data={listData}
        onScrollToIndexFailed={(info) => {
          // Rows vary in height; land near it rather than nowhere.
          listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true });
        }}
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
            tintColor={tokens.accent}
            colors={[tokens.accent]}
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
    paddingHorizontal: Spacing.four - 4,
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
  back: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startCard: {
    gap: Spacing.two,
  },
  // Section names in plain sentence case, the quiet labels Activity and
  // Settings use, never violet capitals.
  sectionTitle: {
    paddingHorizontal: Spacing.two,
    paddingTop: Spacing.two,
  },
});
