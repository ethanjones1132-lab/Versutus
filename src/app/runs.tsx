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
 * What a start or a retry says when the send did not complete.
 *
 * `'error'` and `'cancelled'` are deliberately absent: the kept draft is this
 * screen's signal for those, and the provider's `lastError` names them where
 * the Chat tab and Home both render it. `'queued'` is the outcome nothing else
 * renders — the offline outbox parks the run AND clears that banner on
 * purpose — so without a line here a queued run is indistinguishable from a
 * refusal, and a later flush starts a run the operator never saw start.
 */
const RUN_QUEUED_COPY = "Not sent — you're offline. It will run when the connection returns.";
const RETRY_PENDING_COPY = 'Retrying…';
const RETRY_REFUSED_COPY = 'Retry did not start — see Chat for the verdict.';
/** A pull that read nothing from the gateway says so instead of ending clean. */
const REFRESH_UNREAD_COPY = "Couldn't refresh from the gateway — showing what was already here";

/**
 * How long the last per-Bot spend wave that READ something keeps this screen's
 * rows fresh enough to skip another — the same window the Spend screen keeps for
 * its own fan-out. Without it a focus that returns inside the minute re-ran a
 * roster read plus one 200-row catalogue read per Bot. A pull to refresh still
 * forces a wave: that is the operator saying the rows on screen are stale.
 */
const SPEND_WAVE_MIN_INTERVAL_MS = 60_000;

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
  // What the last start attempt actually did, for the one outcome nothing else
  // on this screen can name (see RUN_QUEUED_COPY). Cleared by the next edit and
  // by the next attempt, so it can never outlive the words it is about.
  const [startNote, setStartNote] = useState<string | null>(null);
  // The run whose Retry is still being answered, and what the last retry on
  // each card did. A retry that refuses, queues or collides with a running
  // command used to say nothing here at all, and nothing stopped a second tap
  // from firing a second `/run` behind the first.
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null);
  const [retryNotes, setRetryNotes] = useState<Record<string, string>>({});
  // The same pending answer as a ref, so the guard is the operator's second tap
  // and not this screen's next render: two taps in one turn must be one send.
  const retryingRef = useRef<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // A refused refresh read is named below the header instead of ending the
  // spinner as if the pull succeeded; cleared by the next success.
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // A pull-to-refresh re-reads capabilities + gateways and re-reads the two
  // per-Bot folds the scorecards carry (the gateway's jobs and P5's spend).
  // Bumping this signal reaches those reads without remounting the screen —
  // through the same coalescing entry point the focus read uses, never beside
  // it.
  const [runsReloadSignal, setRunsReloadSignal] = useState(0);
  // The gateway's own job list, so a card can carry its Bot's routine health.
  // A gateway that cannot report cron, or a read that fails, leaves it empty
  // and every card with no routine line rather than a claim about work nothing
  // read — and this read never adds a card: the cards stay the runs this
  // device holds.
  const [routineJobs, setRoutineJobs] = useState<CronJob[]>([]);
  // P5's per-Bot spend, so a card can carry what its Bot cost. Empty until a
  // read lands — and a read that throws or is walked away from leaves the last
  // complete one in place rather than blanking it, so no card ever claims a
  // spend nobody read.
  const [spendRows, setSpendRows] = useState<BotSpendRow[]>([]);
  // The roster's names, so a scorecard reads "Forge" rather than its id. They
  // ride the spend fold's own roster: every row carries the name its read was
  // asked with, so the fold needs no roster read of its own — except on a
  // gateway that cannot answer the scoped read, where `readBotSpend` degrades
  // without asking the roster at all. There the fold reads it under the same
  // window, and a read that fails keeps the last names rather than dropping
  // them.
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
    // Belongs to the attempt that earned it; a new attempt replaces it.
    setStartNote(null);
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
      // 'error' and 'cancelled' are named by the provider's `lastError`, which
      // Chat and Home both render, and the kept draft is this screen's half of
      // that verdict. 'queued' has no such surface anywhere: the outbox parks
      // the run and clears that banner on purpose, so with nothing here a
      // queued run reads exactly like a refusal while a later flush starts it.
      setStartNote(outcome === 'queued' ? RUN_QUEUED_COPY : null);
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
  //
  // A retry answers like a start: one send at a time per screen (the ref is
  // set before the await, so a second tap in the same turn is one send and not
  // two), and the verdict is named on the card it was tapped from. Success
  // needs no line — the run it started is a new card in the list — so only the
  // outcomes that leave nothing behind are written down.
  const retryRun = useCallback(
    (run: ActivityRun) => {
      const prompt = run.prompt.trim();
      if (!prompt) return;
      if (retryingRef.current) return;
      retryingRef.current = run.id;
      setRetryingRunId(run.id);
      setRetryNotes((previous) => {
        const next = { ...previous };
        delete next[run.id];
        return next;
      });
      void sendChatInput(`/run ${prompt}`)
        .then((outcome) => {
          if (outcome === 'complete') return;
          setRetryNotes((previous) => ({
            ...previous,
            [run.id]: outcome === 'queued' ? RUN_QUEUED_COPY : RETRY_REFUSED_COPY,
          }));
        })
        .catch(() => {
          setRetryNotes((previous) => ({ ...previous, [run.id]: RETRY_REFUSED_COPY }));
        })
        // Released on every outcome, including a send that rejected outright:
        // a card that stayed "Retrying…" could never be retried again.
        .finally(() => {
          retryingRef.current = null;
          setRetryingRunId(null);
        });
    },
    [sendChatInput],
  );

  const onRefresh = async () => {
    setRefreshing(true);
    const started = Date.now();
    try {
      // `refreshCapabilities` answers whether the reads it attempted landed, so
      // a gateway refusing every one of them ends the pull with the notice
      // below rather than a clean spinner over data nothing re-read.
      const [capabilities] = await Promise.all([refreshCapabilities(), refreshGateways()]);
      if (capabilities === false) {
        setRefreshError(REFRESH_UNREAD_COPY);
      } else {
        setRefreshError(null);
      }
    } catch (caught) {
      setRefreshError(caught instanceof Error ? caught.message : String(caught));
    }
    setRunsReloadSignal((n) => n + 1);
    // Hold the spinner briefly so recovery isn't a disorienting flash.
    const elapsed = Date.now() - started;
    if (elapsed < 400) await new Promise((resolve) => setTimeout(resolve, 400 - elapsed));
    setRefreshing(false);
  };

  // The gateway's own jobs, read for the scorecards' routine line, on two
  // edges: a return to the screen (focus) and a pull-to-refresh, which bumps
  // the reload signal. One read at a time — a caller arriving while a list is
  // still in flight JOINS it instead of issuing a second `cron.list()` for the
  // same list. `settled` is what keeps a caller arriving in the same turn a
  // read answers in from joining one that has already finished, and the
  // generation keeps a slow list that a newer one superseded from painting.
  const jobsInFlight = useRef<{ settled: boolean; promise: Promise<void> } | null>(null);
  const jobsGeneration = useRef(0);

  const loadRoutineJobs = useCallback((): Promise<void> => {
    const running = jobsInFlight.current;
    if (running && !running.settled) return running.promise;
    const id = ++jobsGeneration.current;
    const ticket = { settled: false, promise: Promise.resolve() };
    jobsInFlight.current = ticket;
    ticket.promise = (async () => {
      try {
        const jobs =
          status === 'connected' && cron.available
            ? await cron.list().catch(() => [] as CronJob[])
            : ([] as CronJob[]);
        if (id === jobsGeneration.current) setRoutineJobs(jobs);
      } finally {
        // Released on both outcomes, so a refused list never wedges the screen
        // against every later read.
        ticket.settled = true;
        if (jobsInFlight.current === ticket) jobsInFlight.current = null;
      }
    })();
    return ticket.promise;
  }, [cron, status]);

  useFocusEffect(
    useCallback(() => {
      void loadRoutineJobs();
    }, [loadRoutineJobs]),
  );

  // P5's per-Bot spend, read for the cards' spend line: the read is the Spend
  // screen's own (`readBotSpend`), so a card and that screen word one read the
  // same way. It hangs off the same two edges as the job list above, and the
  // scoped read joins the source only when the client advertises it — a gateway
  // that could only refuse is never asked. A read that throws leaves the last
  // complete rows on screen, so every card still says what was last actually
  // read rather than a zero nobody read.
  //
  // This one is the expensive fold — a roster read plus one 200-row catalogue
  // read per Bot, two at a time — so it keeps the Spend screen's ledger: a wave
  // still running is JOINED, a wave that READ something and finished inside
  // `SPEND_WAVE_MIN_INTERVAL_MS` is skipped unless the operator pulled to
  // refresh, and the rows and the roster names land from that one read. A newer
  // wave, and leaving the screen, abort the lanes still out rather than leaving
  // them to paint or to grow another attempt behind the transport's back.
  const spendWave = useRef<{
    ticket: { settled: boolean; promise: Promise<void> } | null;
    controller: AbortController | null;
    completedAt: number;
    gatewayId: string | undefined;
    scoped: boolean | undefined;
  }>({ ticket: null, controller: null, completedAt: 0, gatewayId: undefined, scoped: undefined });
  const spendGeneration = useRef(0);
  const gatewayId = activeGateway?.id;

  // The edge a refresh notice describes: it was set while the gateway was
  // refusing reads, so a connection that comes back — and a read that then lands
  // on it — retires the notice instead of leaving it up until the next pull.
  const lastStatus = useRef(status);
  const recoveringFrom = useRef(false);
  useEffect(() => {
    const connected = status === 'connected';
    recoveringFrom.current = connected && lastStatus.current !== 'connected';
    lastStatus.current = status;
  }, [status]);

  // The walk-away: a blur or an unmount ends the wave. The signal travels the
  // whole way down — into each Bot read's retry ladder — so no further lane is
  // issued and an abandoned lane grows no second attempt. The slot is released
  // at the same moment, so the next focus starts a wave of its own instead of
  // joining one that is on its way out, and the generation moves so the answer
  // still to arrive paints nothing.
  const stopSpendWave = useCallback(() => {
    const ledger = spendWave.current;
    ledger.controller?.abort();
    ledger.controller = null;
    ledger.ticket = null;
    spendGeneration.current += 1;
  }, []);

  const loadBotSpend = useCallback(
    (force?: boolean): Promise<void> => {
      const ledger = spendWave.current;
      // Rows are per gateway, so another gateway starts its own ledger rather
      // than inheriting this one's freshness claim.
      if (ledger.gatewayId !== gatewayId) {
        ledger.gatewayId = gatewayId;
        ledger.completedAt = 0;
        stopSpendWave();
      }
      // The roster this fold can ask for changes with the per-Bot capability, so
      // a wave answered WITHOUT the scoped read says nothing about the one that
      // can: the claim is dropped across the flip rather than carried over it.
      if (ledger.scoped !== canReadBotSessions) {
        ledger.scoped = canReadBotSessions;
        ledger.completedAt = 0;
        stopSpendWave();
      }
      // Nothing to read from a gateway this device is not connected to, so no
      // wave is created at all. A wave that asked nothing may not claim the
      // window either — that claim is what used to swallow the connect landing
      // right after it, leaving the scorecards empty for the whole minute.
      if (status !== 'connected') return Promise.resolve();
      const running = ledger.ticket;
      if (running && !running.settled) return running.promise;
      if (
        !force &&
        ledger.completedAt !== 0 &&
        Date.now() - ledger.completedAt < SPEND_WAVE_MIN_INTERVAL_MS
      ) {
        return Promise.resolve();
      }
      const id = ++spendGeneration.current;
      ledger.controller?.abort();
      const controller = new AbortController();
      ledger.controller = controller;
      const ticket = { settled: false, promise: Promise.resolve() };
      ledger.ticket = ticket;
      ticket.promise = (async () => {
        // Only a wave that finished a read has said anything about how fresh
        // these rows are; one that aborted or threw claims nothing.
        let read = false;
        try {
          if (canReadBotSessions) {
            const report = await readBotSpend(
              { listBots, readBotSessions },
              { signal: controller.signal },
            );
            if (controller.signal.aborted || id !== spendGeneration.current) return;
            read = true;
            setSpendRows(report.rows);
            // The roster this very read asked with: every row carries its Bot's
            // name, so the scorecards need no roster read of their own.
            setBotNames(Object.fromEntries(report.rows.map((row) => [row.botId, row.label])));
          } else {
            // Without the scoped read the fan-out degrades without asking the
            // roster at all, so the names have to be read here — under this
            // fold's own window and generation, so a focus never repeats it.
            const roster = await listBots();
            if (controller.signal.aborted || id !== spendGeneration.current) return;
            read = true;
            setBotNames(Object.fromEntries(roster.map((bot) => [bot.id, bot.displayName])));
          }
          if (recoveringFrom.current) {
            // The connection the notice was about is back and a read landed on
            // it, so the state that notice described has passed.
            recoveringFrom.current = false;
            setRefreshError(null);
          }
        } catch {
          // A failed read is not an answer: it blanks none of what the last
          // complete wave read, and claims no freshness, so the next focus or
          // pull asks again at once.
        } finally {
          ticket.settled = true;
          // Only the wave still in charge may clear the ledger: a superseded
          // wave must not free the slot the newer one is holding.
          if (ledger.controller === controller) {
            ledger.ticket = null;
            ledger.controller = null;
            if (read && !controller.signal.aborted) ledger.completedAt = Date.now();
          }
        }
      })();
      return ticket.promise;
    },
    [canReadBotSessions, gatewayId, listBots, readBotSessions, status, stopSpendWave],
  );

  // The focus read and its walk-away, in the one edge that owns both.
  useFocusEffect(
    useCallback(() => {
      void loadBotSpend();
      return stopSpendWave;
    }, [loadBotSpend, stopSpendWave]),
  );

  // The reload signal reaches both folds through the entry points above, never
  // beside them. The focus effects already read on the first focus, so this one
  // runs for changes to the signal after that read — and it forces the spend
  // wave, because a pull is the operator saying the rows on screen are stale.
  const mountedRunsSignal = useRef(runsReloadSignal);
  useEffect(() => {
    if (runsReloadSignal === mountedRunsSignal.current) return undefined;
    mountedRunsSignal.current = runsReloadSignal;
    const timer = setTimeout(() => {
      void loadRoutineJobs();
      void loadBotSpend(true);
    }, 0);
    return () => clearTimeout(timer);
  }, [loadBotSpend, loadRoutineJobs, runsReloadSignal]);

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
        case 'finished': {
          // While a retry is in flight the affordance is withdrawn rather than
          // left live: a second tap is what fired a second `/run` before, and a
          // button that reads as available while it is not is the same lie.
          const retrying = retryingRunId === item.run.id;
          const note = retrying ? RETRY_PENDING_COPY : retryNotes[item.run.id];
          return (
            <View>
              <RunCard
                run={item.run}
                highlighted={item.id === focusedRunId}
                onOpenTranscript={setOpenAgenticRunId}
                onRetry={retrying ? undefined : (prompt) => retryRun({ ...item.run, prompt })}
              />
              {/* What the retry actually did, on the card it was tapped from —
                  the only surface a queued or refused retry has on this screen.
                  A retry that completed needs no line: the run it started is a
                  new card in the list. */}
              {note ? (
                <Text variant="caption" color="secondary">
                  {note}
                </Text>
              ) : null}
            </View>
          );
        }
      }
    },
    [stopActivityRun, retryRun, focusedRunId, retryingRunId, retryNotes],
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
                  onChangeText={(next) => {
                    setRunPrompt(next);
                    // The note is about the words that were sent, so a new draft
                    // retires it.
                    setStartNote(null);
                  }}
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
                {/* Where a start that did not complete actually went. The draft
                    stays either way, so without this line a queued run and a
                    refused one read exactly alike. */}
                {startNote ? (
                  <Text variant="caption" color="statusConnecting">
                    {startNote}
                  </Text>
                ) : null}
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
                  // `connectGateway` rethrows an auth refusal by design and this
                  // action is fire-and-forget, so without a handler a refused
                  // key was an unhandled rejection with nothing on screen. The
                  // refresh notice is the screen's one error line, and the
                  // provider has already written the same reason into
                  // `lastError`.
                  void connectGateway(activeGateway).catch((caught: unknown) => {
                    setRefreshError(caught instanceof Error ? caught.message : String(caught));
                  });
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
