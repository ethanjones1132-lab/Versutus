import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';

import { CronJobSheet } from '@/components/activity/cron-job-sheet';
import { CronRunSheet } from '@/components/activity/cron-run-sheet';
import { NewRoutineSheet } from '@/components/routines/new-routine-sheet';
import { routineCoverageLine } from '@/lib/routines/coverage';
import { routineTargets } from '@/lib/routines/targets';
import { gatewayJobInput } from '@/lib/gateway/cron-create';
import type { PublicBot } from '@/lib/gateway/bots';
import { BackendFilterRow } from '@/components/ui/backend-filter-row';
import { Button, Card, ErrorCard, ListRow, SectionHeader, Skeleton, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import {
  applyRoutineFeedRead,
  EMPTY_ROUTINE_FEED_STATE,
  readFailureKind,
  type ActivityCoverage,
  type RoutineEntry,
  type RoutineFeedState,
  type RoutineScope,
} from '@/lib/gateway/activity-feed';
import type { CronJob } from '@/lib/gateway/cron';
import { cronJobViewFromRoutine, routineJobSummary } from '@/lib/gateway/routines';

/**
 * Every backend's routines, grouped by the Bot that owns them.
 *
 * A backend with no routine concept says so in its own quiet line — never a
 * failure, never a zero. Bots that are not set up yet are counted, not quoted,
 * and stay neutral. Only a read that really failed is red, and it carries one
 * sentence of the Gate's reason beside a Retry. Which backend answered what is
 * a per-host fact, so each row names its backend and every backend gets a
 * coverage line.
 */
export function RoutinesSection({ reloadSignal = 0 }: { reloadSignal?: number }) {
  const { activeGateway, activityFeed, status, botJobs, listBots } = useGateway();
  // The feed, the filter and every open read belong to one Gate. Keying the
  // state to this id keeps a late answer from the Gate we just left from
  // painting under the one on screen.
  const gatewayId = activeGateway?.id;
  const [owned, setOwned] = useState<{ gatewayId?: string; state: RoutineFeedState }>({
    gatewayId,
    state: EMPTY_ROUTINE_FEED_STATE,
  });
  const state = owned.gatewayId === gatewayId ? owned.state : EMPTY_ROUTINE_FEED_STATE;
  // Why the last read was refused, for the four states that are not the same
  // fact: an older Gate with no route, a refused token, a dead network, and a
  // read that genuinely failed.
  const [failure, setFailure] = useState<{
    gatewayId?: string;
    kind: ReturnType<typeof readFailureKind>;
  } | null>(null);
  const failureKind = failure && failure.gatewayId === gatewayId ? failure.kind : undefined;
  const [backendFilter, setBackendFilter] = useState<string | undefined>();
  const [openJob, setOpenJob] = useState<CronJob | null>(null);
  // Activity rows always carry their exact home. Root is explicit so a Bot
  // selected elsewhere cannot redirect a root job into that profile.
  const [openJobScope, setOpenJobScope] = useState<RoutineScope | undefined>();
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  // New routine (VS-121): any backend the Gate serves routines for, or any of
  // its Bots, chosen here rather than inherited from the open chat.
  const [newOpen, setNewOpen] = useState(false);
  const [bots, setBots] = useState<PublicBot[]>([]);
  const requestId = useRef(0);
  const inFlight = useRef<{ settled: boolean; promise: Promise<void>; gatewayId?: string } | null>(null);
  const mounted = useRef(true);
  const gatewayIdRef = useRef(gatewayId);

  // A Gate switch is a change of owner for every row: retire the read still in
  // flight so the new Gate cannot join it, and clear what the previous one
  // left on screen. Deferred a tick because a loader effect that writes state
  // synchronously trips react-hooks/set-state-in-effect.
  useEffect(() => {
    gatewayIdRef.current = gatewayId;
    requestId.current += 1;
    inFlight.current = null;
    const timer = setTimeout(() => {
      if (gatewayIdRef.current !== gatewayId) return;
      setOwned({ gatewayId, state: EMPTY_ROUTINE_FEED_STATE });
      setFailure(null);
      setBackendFilter(undefined);
      setOpenJob(null);
      setOpenJobScope(undefined);
      setOpenRunId(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [gatewayId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const read = useCallback((): Promise<void> => {
    if (status !== 'connected') return Promise.resolve();
    const gateId = gatewayId;
    const active = inFlight.current;
    // Join only a read that covers the same Gate; one opened for the Gate we
    // left cannot answer this one's question.
    if (active && !active.settled && active.gatewayId === gatewayId) return active.promise;
    const id = ++requestId.current;
    const ticket: { settled: boolean; promise: Promise<void>; gatewayId?: string } = {
      settled: false,
      promise: Promise.resolve(),
      gatewayId,
    };
    inFlight.current = ticket;
    ticket.promise = (async () => {
      try {
        const feed = await activityFeed.readRoutines();
        if (mounted.current && id === requestId.current && gateId === gatewayIdRef.current) {
          setOwned((previous) => ({
            gatewayId: gateId,
            state: applyRoutineFeedRead(
              previous.gatewayId === gateId ? previous.state : EMPTY_ROUTINE_FEED_STATE,
              { ok: true, feed },
            ),
          }));
          setFailure(null);
        }
      } catch (caught) {
        if (mounted.current && id === requestId.current && gateId === gatewayIdRef.current) {
          setOwned((previous) => ({
            gatewayId: gateId,
            state: applyRoutineFeedRead(
              previous.gatewayId === gateId ? previous.state : EMPTY_ROUTINE_FEED_STATE,
              { ok: false, error: caught instanceof Error ? caught.message : String(caught) },
            ),
          }));
          setFailure({ gatewayId: gateId, kind: readFailureKind(caught) });
        }
      } finally {
        ticket.settled = true;
        if (inFlight.current === ticket) inFlight.current = null;
      }
    })();
    return ticket.promise;
  }, [activityFeed, gatewayId, status]);

  useEffect(() => {
    const timer = setTimeout(() => { void read(); }, 0);
    return () => clearTimeout(timer);
  }, [read, reloadSignal]);

  // A routine that starts or finishes while the app is backgrounded keeps its
  // old verdict until the next read; the foreground return is that read.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      void read();
    });
    return () => subscription.remove();
  }, [read]);

  const feed = state.feed;
  useEffect(() => {
    // A context without a Bot list (an older provider, a test double) offers
    // backend targets only.
    if (typeof listBots !== 'function') return undefined;
    let live = true;
    void Promise.resolve(listBots()).then(
      (result) => { if (live) setBots(Array.isArray(result) ? result : []); },
      () => { if (live) setBots([]); },
    );
    return () => { live = false; };
  }, [listBots]);
  useEffect(() => {
    if (backendFilter && feed && !feed.backends.some((backend) => backend.id === backendFilter)) {
      setBackendFilter(undefined);
    }
  }, [backendFilter, feed]);

  const visibleBackends = feed
    ? (backendFilter ? feed.backends.filter((backend) => backend.id === backendFilter) : feed.backends)
    : [];
  const visibleRoutines = feed
    ? (backendFilter ? feed.routines.filter((routine) => routine.backendId === backendFilter) : feed.routines)
    : [];
  const counts = new Map<string, number>();
  for (const routine of visibleRoutines) {
    counts.set(routine.backendId, (counts.get(routine.backendId) ?? 0) + 1);
  }
  const groups = groupRoutinesByBot(visibleRoutines);
  // A plain "none" is only true when every backend on screen answered. One
  // refused or unreadable backend keeps the empty claim off the screen.
  const everyBackendAnswered =
    visibleBackends.length > 0 && visibleBackends.every((backend) => backend.status === 'complete');
  return (
    <View style={styles.root}>
      {!state.loaded && state.failed && failureKind === 'unsupported' ? (
        // An older Gate has no /v1/routines: nothing to report, nothing broken.
        <Text variant="caption" color="tertiary">This gateway does not report routines.</Text>
      ) : null}
      {!state.loaded && state.failed && failureKind === 'offline' ? (
        <Text variant="caption" color="tertiary">Connect to a gateway to see routines.</Text>
      ) : null}
      {!state.loaded && state.failed && failureKind === 'unauthorized' ? (
        <ErrorCard
          cause={state.error ?? 'Routines could not be read.'}
          affected="Routines on this gateway"
          next="Check this gateway's token, then retry."
          onRetry={() => void read()}
        />
      ) : null}
      {!state.loaded && state.failed && (failureKind === 'failed' || failureKind === undefined) ? (
        <ErrorCard
          cause={state.error ?? 'Routines could not be read.'}
          affected="Routines on this gateway"
          next="Retry the read."
          onRetry={() => void read()}
        />
      ) : null}
      {!state.loaded && !state.failed && status !== 'connected' ? (
        <Text variant="caption" color="tertiary">Connect to a gateway to see routines.</Text>
      ) : null}
      {!state.loaded && !state.failed && status === 'connected' ? (
        <Card variant="stage" padding={Spacing.three} style={styles.skeleton}>
          <Skeleton />
          <Skeleton width="72%" />
          <Skeleton width="48%" />
        </Card>
      ) : null}
      {feed ? (
        <>
          <SectionHeader title={`Routines${visibleRoutines.length ? ` (${visibleRoutines.length})` : ''}`} />
          <Button label="New routine" variant="secondary" onPress={() => setNewOpen(true)} />
          {newOpen ? (
          <NewRoutineSheet
            visible={newOpen}
            targets={routineTargets(feed.backends, feed.routines, bots)}
            initialBackendId={backendFilter}
            onClose={() => setNewOpen(false)}
            onCreate={(draft, scope) =>
              botJobs.create(gatewayJobInput(draft), scope).then((created) => {
                setNewOpen(false);
                void read();
                return created;
              })
            }
          />
          ) : null}
          {feed.backends.length > 1 ? (
            <BackendFilterRow
              filters={feed.backends}
              selected={backendFilter}
              onSelect={setBackendFilter}
              accessibilityLabel="Filter routines by backend"
            />
          ) : null}
          {[...groups.entries()].map(([botId, routines]) => (
            <View key={botId ?? 'gateway'} style={styles.group}>
              {groups.size > 1 || botId ? (
                <Text variant="micro" color="secondary">
                  {botId ? `Bot ${bots.find((bot) => bot.id === botId)?.displayName ?? botId}` : 'Gateway'}
                </Text>
              ) : null}
              {routines.map((routine) => (
                <ListRow
                  key={routineIdentity(routine)}
                  title={routine.name}
                  subtitle={routineJobSummary(routine)}
                  onPress={() => {
                    setOpenJob(routineJobView(routine));
                    setOpenJobScope({ backendId: routine.backendId, botId: routine.scopeBotId ?? null });
                  }}
                  trailing={
                    <Text variant="micro" color="secondary">
                      {backendLabel(feed.backends, routine.backendId)}
                    </Text>
                  }
                  style={styles.row}
                />
              ))}
            </View>
          ))}
          {visibleRoutines.length === 0 && everyBackendAnswered ? (
            <Text variant="caption" color="tertiary">
              {backendFilter ? 'No routines on this backend.' : 'No routines on any backend.'}
            </Text>
          ) : null}
          {state.failed && state.loaded ? (
            <Text variant="caption" color="tertiary">Could not refresh — showing the last read.</Text>
          ) : null}
          {visibleBackends.map((coverage) => {
            const line = routineCoverageLine(coverage, counts.get(coverage.id) ?? 0);
            return (
              <View key={coverage.id} style={styles.coverage}>
                <Text
                  variant="caption"
                  color={line.failed ? 'statusDisconnected' : 'tertiary'}
                  style={styles.coverageText}
                >
                  {`${coverage.label}: ${line.text}`}
                </Text>
                {line.failed ? (
                  <Button label="Retry" variant="ghost" size="sm" onPress={() => void read()} />
                ) : null}
              </View>
            );
          })}
          {status !== 'connected' && state.updatedAt ? (
            <Text variant="caption" color="tertiary">
              {`Last updated ${new Date(state.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`}
            </Text>
          ) : null}
        </>
      ) : null}

      <CronJobSheet
        key={routineSelectionIdentity(openJob, openJobScope)}
        // Hide while a run transcript is open so two BaseSheets do not stack.
        job={openRunId ? null : openJob}
        scope={openJobScope}
        onClose={() => {
          setOpenJob(null);
          setOpenJobScope(undefined);
        }}
        onOpenRun={(runId) => setOpenRunId(runId)}
        onRemoved={() => {
          setOpenJob(null);
          setOpenJobScope(undefined);
          void read();
        }}
        onChanged={() => void read()}
      />
      <CronRunSheet
        key={`run:${JSON.stringify([openJobScope?.backendId ?? null, openJob?.botId ?? null, openJobScope?.botId ?? null, openRunId])}`}
        runId={openRunId}
        scope={openJobScope}
        onClose={() => setOpenRunId(null)}
      />
    </View>
  );
}

/** Rows grouped by owning Bot, in the order the Gate listed them. */
function groupRoutinesByBot(routines: readonly RoutineEntry[]): Map<string | null, RoutineEntry[]> {
  const groups = new Map<string | null, RoutineEntry[]>();
  for (const routine of routines) {
    const key = routine.botId ?? null;
    const group = groups.get(key);
    if (group) group.push(routine);
    else groups.set(key, [routine]);
  }
  return groups;
}

function routineIdentity(routine: RoutineEntry): string {
  return JSON.stringify([routine.backendId, routine.botId ?? null, routine.scopeBotId ?? null, routine.id]);
}

function routineSelectionIdentity(job: CronJob | null, scope: RoutineScope | undefined): string {
  return `job:${JSON.stringify([scope?.backendId ?? null, job?.botId ?? null, scope?.botId ?? null, job?.id ?? null])}`;
}

/** One routine in the sheet's CronJob shape, so editing stays where it was. */
function routineJobView(routine: RoutineEntry): CronJob {
  return cronJobViewFromRoutine({
    id: routine.id,
    name: routine.name,
    botId: routine.botId,
    paused: routine.paused,
    schedule: routine.schedule,
    scheduleDisplay: routine.scheduleDisplay,
    lastStatus: routine.lastStatus,
    lastRunAt: routine.lastRunAt,
    nextRunAt: routine.nextRunAt,
  });
}

function backendLabel(backends: readonly ActivityCoverage[], id: string): string {
  return backends.find((backend) => backend.id === id)?.label ?? id;
}

const styles = StyleSheet.create({
  root: { gap: Spacing.three },
  group: { gap: Spacing.two },
  row: { marginBottom: Spacing.one },
  coverage: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.two },
  coverageText: { flex: 1, minWidth: 0 },
  skeleton: { gap: Spacing.two },
});
