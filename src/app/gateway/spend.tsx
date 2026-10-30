import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { SpendChart } from '@/components/gateway/spend-chart';
import { SpendPerBotSection } from '@/components/gateway/spend-per-bot-section';
import { SpendSessionTable } from '@/components/gateway/spend-session-table';
import { Card, EmptyState, ErrorCard, Icon, PageTitle, PressableScale, Screen, Skeleton, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import {
  BUDGETS_UNREAD,
  loadBudgets,
  saveBudgets,
  setBotBudget,
  type BotBudgets,
} from '@/lib/gateway/budgets';
import {
  EMPTY_SESSION_SPEND,
  SESSION_SPEND_LIST_LIMIT,
  applySessionSpendRead,
  sessionSpendCopy,
  sessionSpendReadFromUnknown,
  spendTotalBoundCopy,
  totalUsage,
  weekBuckets,
  type SessionSpendState,
} from '@/lib/gateway/session-analytics';
import {
  readBotSpend,
  SPEND_UNREAD_COPY,
  spendBasisCopy,
  spendCostBasis,
  spendSessionRows,
  type BotSpendReport,
  type BotSpendSource,
} from '@/lib/gateway/spend-report';

/**
 * How long a completed per-Bot fan-out keeps this screen from asking again.
 *
 * `status` flips on every connection-monitor self-heal as well as on every real
 * connect, so keying the fan-out on it re-ran the whole roster — one 200-row
 * scoped catalogue read per Bot, two at a time, each with its own retry ladder —
 * per transition, on a Gate the repo documents as single-threaded and
 * state.db-bound. One wave per visit; a reconnect earns a new wave only once the
 * last complete one is this old.
 */
const BOT_SPEND_WAVE_MIN_INTERVAL_MS = 60_000;

/**
 * One read's answer, kept with the gateway it was read from.
 *
 * Nothing this screen shows about spend is this device's: the total, the week,
 * the session rows and the per-Bot report are that PC's. Tagging each answer
 * with its gateway is what keeps a switch honest without a frame of the
 * previous gateway's numbers under the new one's name — the value is only read
 * back when the tag matches the gateway on screen, so clearing follows from the
 * switch itself rather than from an effect racing the first read.
 */
type GatewayRead<T> = { gatewayId: string | undefined; value: T };

/**
 * The budget read's own failure line. Not the spend read's: no cap was read, so
 * nothing here is a total — and nothing may be written over caps this device
 * could not see, because the writer saves the whole map back.
 */
const BUDGETS_UNREAD_COPY = 'The budget caps stored on this device could not be read.';

/**
 * P5's screen: what this gateway's sessions have cost.
 *
 * One read answers the total — the same `sessions.list` catalogue the thread
 * glance reads, at the same cap — and every number on screen comes from the
 * folds that read already feeds (`totalUsage`, `sessionSpendCopy`,
 * `spendTotalBoundCopy`, `spendCostBasis` / `spendBasisCopy`). Nothing is
 * aggregated a second time here.
 *
 * A spend surface is a claim, so `applySessionSpendRead` is the only thing
 * that moves the total's state: an unread catalogue stays unread and is named
 * ("Spend could not be read.") rather than folded into a zero, and the cost
 * header comes from the basis the sessions actually carry — `actual`,
 * `estimated`, or `none` when the gateway reports tokens only.
 *
 * The read's own state is three surfaces, never one caption standing in for
 * all of them: in flight is a Skeleton, a refusal is an ErrorCard that keeps
 * the caught cause and offers a Retry (`retrySpendRead` re-reads while
 * connected and reconnects otherwise), and a disconnected screen is an
 * EmptyState naming the wait. A stale re-read keeps the last total above and
 * announces itself through that same ErrorCard.
 *
 * The per-Bot rows are one additional fan-out per visit (`readBotSpend`): one
 * scoped catalogue read per roster Bot, started once when the screen mounts
 * connected and never a second time while the previous wave is still running.
 * A `status` flap back to connected re-reads only when the last COMPLETE wave is
 * more than a minute old, and leaving the screen aborts the wave. The section
 * is offered only when the connected client can scope a catalogue by Bot, so a
 * gateway that could only refuse is never asked.
 *
 * The per-session table is the total's own read again, sorted by cost
 * (`spendSessionRows`) — the same rows, once, in the read the screen already
 * made.
 *
 * The 7-day chart is that same read a third time, folded by `weekBuckets` into
 * one bucket per local day and placed by `spendChartBars`, which is what each
 * render path paints. The fold is computed once, here — the chart aggregates
 * nothing of its own, and the `now` it buckets against is captured on mount,
 * the way the thread glance captures it.
 *
 * Both bound lines on this screen — the total's bound line and the table's
 * cap — are decided by `state.rowCount`, the rows the read held, so a capped
 * read names its cap even when a row it could not parse was dropped. The
 * total's line names that cap without a window claim: this total folds the
 * whole catalogue read, whose age is unbounded, so the "Last 7 days" line
 * (`spendWindowCopy`) belongs to the 7-day chart and not here.
 *
 * A gateway switch is a change of subject: every number here is one PC's, so
 * each read is tagged with the gateway it was asked of and is only shown while
 * that gateway is still on screen. A read in flight when the gateway changes is
 * cancelled, and a read for the new gateway that FAILS starts from "nothing
 * known" — it never retains the previous gateway's total or rows, which would
 * otherwise sit under the new gateway's name beside the error.
 *
 * The caps are this device's, and the writer saves the whole map back, so the
 * store is read through `BUDGETS_UNREAD`: caps that could not be read are
 * unknown caps, not no caps. Until a read succeeds no cap is written and the
 * failure is named where a cap would be set, so a first edit can never save a
 * one-entry map over every other Bot's cap.
 *
 * The entry points are their own slice of P5.
 */
export default function GatewaySpendScreen() {
  const router = useRouter();
  const {
    gatewayRequest,
    status,
    listBots,
    readBotSessions,
    canReadBotSessions,
    activeGateway,
    retryAutoConnect,
  } = useGateway();
  const gatewayId = activeGateway?.id;
  const [spendRead, setSpendRead] = useState<GatewayRead<SessionSpendState>>({
    gatewayId: undefined,
    value: EMPTY_SESSION_SPEND,
  });
  const [readError, setReadError] = useState<string | null>(null);
  const [botReport, setBotReport] = useState<GatewayRead<BotSpendReport> | null>(null);
  const [budgets, setBudgets] = useState<BotBudgets>({});
  const [budgetsStatus, setBudgetsStatus] = useState<'pending' | 'loaded' | 'unread'>('pending');
  const [now] = useState(() => Date.now());

  // What this screen may paint: only the reads that belong to the gateway on
  // screen. A previous gateway's numbers stay in state, where they belong, and
  // never reach the page — a failed read for the new gateway lands on the empty
  // state, so it cannot resurrect them either.
  const state = spendRead.gatewayId === gatewayId ? spendRead.value : EMPTY_SESSION_SPEND;
  const report = botReport && botReport.gatewayId === gatewayId ? botReport.value : null;

  // What the read below found in storage, kept so the writer can tell a cap
  // that was just read back from one the operator set.
  const loadedBudgets = useRef<BotBudgets | null>(null);

  // The store read's generation: a retry (or leaving the screen) retires the
  // answer of the read it supersedes.
  const budgetsReadGeneration = useRef(0);

  // D5's caps are this device's; read them once for the budget rows — and again
  // only when the operator asks, because a store that could not be read is not
  // an empty one. `BUDGETS_UNREAD` says so, and until a read succeeds nothing
  // may be written: the writer below saves the whole map, so one cap set over
  // caps this device never saw would delete every other Bot's.
  const readStoredBudgets = useCallback(() => {
    // Each read retires the answer of the one it supersedes, so a slow failure
    // cannot land after a newer success and shut the writer again.
    const generation = budgetsReadGeneration.current + 1;
    budgetsReadGeneration.current = generation;
    void loadBudgets().then((stored) => {
      if (generation !== budgetsReadGeneration.current) return;
      if (stored === BUDGETS_UNREAD) {
        setBudgetsStatus('unread');
        return;
      }
      loadedBudgets.current = stored;
      setBudgets(stored);
      setBudgetsStatus('loaded');
    });
  }, []);

  useEffect(() => {
    readStoredBudgets();
    // Leaving the screen retires the read the way a retry does.
    return () => {
      budgetsReadGeneration.current += 1;
    };
  }, [readStoredBudgets]);

  const handleSetBudget = (botId: string, cap: number | undefined) => {
    const budgetGatewayId = activeGateway?.id;
    // No write before a successful read: unknown caps are not no caps.
    if (!budgetGatewayId || budgetsStatus !== 'loaded') return;
    setBudgets((previous) => setBotBudget(previous, budgetGatewayId, botId, cap));
  };

  // The one writer, and deliberately outside every state updater: React may
  // invoke an updater more than once or discard it, so a write issued from one
  // is not tied to a state that ever committed. Keyed on `budgets`, this sees
  // only what committed — and the value just read back from storage is not a
  // change, so the load above writes nothing.
  useEffect(() => {
    if (budgetsStatus !== 'loaded' || loadedBudgets.current === budgets) return;
    void saveBudgets(budgets);
  }, [budgets, budgetsStatus]);

  // The one catalogue read, shared by the connection effect and the
  // ErrorCard's Retry: a refusal keeps its caught message as the cause
  // instead of discarding it, so recovery means re-running this read — not
  // leaving the screen.
  const spendReadGeneration = useRef(0);
  const loadSpend = useCallback(
    (isCancelled: () => boolean) => {
      const generation = ++spendReadGeneration.current;
      // The gateway this read is for, captured now: an answer belongs to the
      // gateway it was asked of, whatever is on screen when it lands.
      const readFor = gatewayId;
      const current = (previous: GatewayRead<SessionSpendState>) =>
        previous.gatewayId === readFor ? previous.value : EMPTY_SESSION_SPEND;
      void gatewayRequest('sessions.list', { limit: SESSION_SPEND_LIST_LIMIT })
        .then((payload) => {
          if (isCancelled()) return;
          if (generation !== spendReadGeneration.current) return;
          setReadError(null);
          setSpendRead((previous) => ({
            gatewayId: readFor,
            // A failed re-read keeps the last good list, but only the list this
            // same gateway read: another gateway's sessions are never retained
            // as this one's.
            value: applySessionSpendRead(current(previous), sessionSpendReadFromUnknown(payload)),
          }));
        })
        .catch((caught) => {
          if (isCancelled()) return;
          if (generation !== spendReadGeneration.current) return;
          setReadError(caught instanceof Error ? caught.message : String(caught));
          setSpendRead((previous) => ({
            gatewayId: readFor,
            value: applySessionSpendRead(current(previous), { ok: false }),
          }));
        });
    },
    [gatewayId, gatewayRequest],
  );

  useEffect(() => {
    if (status !== 'connected') return;
    let cancelled = false;
    loadSpend(() => cancelled);
    return () => {
      cancelled = true;
      spendReadGeneration.current += 1;
    };
  }, [loadSpend, status]);

  const retrySpendRead = () => {
    // The disconnected card names the connect as the next step — retrying the
    // read would never land — so Retry re-runs the connect cycle; the
    // connected refusal retries the failing call itself.
    if (status === 'connected') {
      loadSpend(() => false);
    } else {
      void retryAutoConnect();
    }
  };

  // The per-Bot fan-out's ledger, held outside state because it is bookkeeping
  // about the wave rather than anything this screen paints: which controller is
  // in charge, whether one is still running, when the last COMPLETE one ended,
  // and which gateway those answers belong to.
  const botWave = useRef<{
    controller: AbortController | null;
    running: boolean;
    completedAt: number;
    gatewayId: string | undefined;
  }>({ controller: null, running: false, completedAt: 0, gatewayId: undefined });

  // A gateway switch hands the ledger over: the previous PC's wave is stopped
  // here rather than left to finish reads whose answer belongs to a gateway
  // that is no longer on screen, and its freshness claim goes with it. Caps and
  // rows are per gateway, so a different gateway starts its own ledger rather
  // than inheriting the previous PC's.
  useEffect(() => {
    const ledger = botWave.current;
    ledger.controller?.abort();
    ledger.controller = null;
    ledger.running = false;
    ledger.completedAt = 0;
    ledger.gatewayId = gatewayId;
  }, [gatewayId]);

  const runBotSpendWave = useCallback(() => {
    const ledger = botWave.current;
    // The handover effect above owns which gateway this ledger answers for. A
    // runner asked about a gateway the ledger has not been handed claims
    // nothing — it would be reading the wrong PC's roster under this one's name.
    if (ledger.gatewayId !== gatewayId) return;
    // Never two waves at once, and a reconnect earns a new wave only once the
    // last complete one is stale.
    if (ledger.running) return;
    if (ledger.completedAt !== 0 && Date.now() - ledger.completedAt < BOT_SPEND_WAVE_MIN_INTERVAL_MS) {
      return;
    }
    // A newer wave supersedes whatever was running: its lanes stop issuing
    // reads and its result is discarded rather than written over this one.
    ledger.controller?.abort();
    const controller = new AbortController();
    ledger.controller = controller;
    ledger.running = true;
    // The scoped read joins the source only when the client advertises it: its
    // absence is what makes the report `degraded`, and the roster is not asked
    // at all on that path.
    const source: BotSpendSource = canReadBotSessions ? { listBots, readBotSessions } : { listBots };
    void readBotSpend(source, { signal: controller.signal })
      .then((read) => {
        if (controller.signal.aborted) return;
        // Tagged like the total: a report belongs to the gateway it was read
        // from, so it is never painted under another one's name.
        setBotReport({ gatewayId, value: read });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        // A thrown roster read is NOT the `degraded` fact: that line claims this
        // gateway cannot split spend by Bot, which is a different — and
        // possibly false — statement about a gateway that merely went quiet.
        // Nothing is claimed instead, and the section is withdrawn.
        setBotReport(null);
      })
      .finally(() => {
        // Only the wave still in charge may clear the ledger: a superseded
        // wave must not free the slot the newer one is holding.
        if (ledger.controller !== controller) return;
        ledger.controller = null;
        ledger.running = false;
        // Only a wave that finished its roster has said anything about how
        // fresh these rows are; an abandoned one claims nothing.
        if (!controller.signal.aborted) ledger.completedAt = Date.now();
      });
  }, [canReadBotSessions, gatewayId, listBots, readBotSessions]);

  const connected = status === 'connected';

  // One fan-out per visit. The keys are what really changes the data — the
  // gateway, the per-Bot capability, and whether a connection is live at all —
  // never `status` itself, which moves on every monitor self-heal; the runner
  // decides whether a reconnect deserves a wave of its own.
  useEffect(() => {
    if (!connected) return;
    runBotSpendWave();
  }, [connected, gatewayId, runBotSpendWave]);

  // Leaving the screen ends the wave. The signal travels the whole way down —
  // into each Bot read's retry ladder — so no further lane is issued and a
  // lane already failing with a 5xx grows no second attempt. What it cannot
  // recall is the request already on the wire; the transport owns that abort,
  // and that answer is discarded rather than written.
  useEffect(() => () => botWave.current.controller?.abort(), []);

  const spend = useMemo(() => totalUsage(state.sessions), [state.sessions]);
  const basis = useMemo(() => spendCostBasis(state.sessions), [state.sessions]);
  // The table is the same read, sorted once — not a second aggregation and not
  // a second fetch.
  const sessionRows = useMemo(() => spendSessionRows(state.sessions), [state.sessions]);
  // And the chart is that read's own week: seven local days, folded once here
  // and only placed by the render path.
  const buckets = useMemo(() => weekBuckets(state.sessions, now), [state.sessions, now]);

  return (
    <Screen edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        {/* Spend opens like its sister modal, Settings: the serif title in the
            lamp's light and one quiet line, no header bar above it. */}
        <PageTitle
          title="Spend"
          leading={
            <PressableScale
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/activity'))}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Close spend"
              style={styles.close}>
              <Icon name={{ ios: 'chevron.down', android: 'expand_more', web: 'expand_more' }} size={20} color="textSecondary" />
            </PressableScale>
          }
          status={
            <Text variant="caption" color="secondary" style={styles.headingLine}>
              What this gateway&apos;s sessions have cost, folded from the session catalogue this
              device can read.
            </Text>
          }
        />

        {state.loaded ? (
          <Card variant="hero" padding={Spacing.three} style={styles.card}>
            <Text variant="headline">{spendBasisCopy(basis)}</Text>
            <Text variant="caption" color="secondary">
              {spendTotalBoundCopy(state.rowCount)}
            </Text>
            <Text variant="mono" color="secondary" style={styles.total}>
              {sessionSpendCopy(spend)}
            </Text>
          </Card>
        ) : state.failed ? null : status !== 'connected' ? (
          <EmptyState
            icon={{ ios: 'network', android: 'hub', web: 'hub' }}
            title="Connect to read spend"
            description="Spend is folded from the session catalogue this device reads over the live connection."
            actionLabel="Reconnect"
            onAction={() => void retryAutoConnect()}
          />
        ) : (
          <Card variant="surface" padding={Spacing.three} style={styles.card}>
            <Skeleton height={16} width="55%" />
            <Skeleton height={12} width="40%" />
            <Skeleton height={28} width="65%" />
          </Card>
        )}

        {state.failed ? (
          <ErrorCard
            cause={readError ?? SPEND_UNREAD_COPY}
            affected="spend totals for this gateway"
            next={
              status === 'connected'
                ? 'Retry the session catalogue read.'
                : 'Connect to the gateway, then retry.'
            }
            onRetry={retrySpendRead}
          />
        ) : null}

        {state.loaded ? <SpendChart buckets={buckets} rowCount={state.rowCount} /> : null}

        {report ? (
          <SpendPerBotSection
            report={report}
            gatewayId={activeGateway?.id}
            budgets={budgets}
            onSetBudget={activeGateway ? handleSetBudget : undefined}
          />
        ) : null}

        {/* The caps belong to the per-Bot rows above, so the failure is named
            here, where a cap would be set: unknown caps are never written over. */}
        {report && budgetsStatus === 'unread' ? (
          <ErrorCard
            cause={BUDGETS_UNREAD_COPY}
            affected="the Bot caps stored on this device"
            next="No cap can be saved until they can be read again, because a save replaces the whole stored map."
            retryLabel="Try again"
            onRetry={readStoredBudgets}
          />
        ) : null}

        <SpendSessionTable rows={sessionRows} rowCount={state.rowCount} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: Spacing.four - 4,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.four,
    gap: Spacing.three,
  },
  close: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headingLine: {
    flex: 1,
  },
  card: {
    gap: Spacing.two,
  },
  total: {
    marginTop: Spacing.one,
  },
});
