import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, ScrollView, StyleSheet, View } from 'react-native';

import { CronJobSheet } from '@/components/activity/cron-job-sheet';
import { CronRunSheet } from '@/components/activity/cron-run-sheet';
import { Button, Card, Chip, ErrorCard, ListRow, SectionHeader, Skeleton, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import {
  applyRoutineFeedRead,
  EMPTY_ROUTINE_FEED_STATE,
  readFailureKind,
  type ActivityCoverage,
  type RoutineEntry,
  type RoutineFeedState,
} from '@/lib/gateway/activity-feed';
import type { CronJob } from '@/lib/gateway/cron';
import { cronJobViewFromRoutine, routineJobSummary } from '@/lib/gateway/routines';

/**
 * Every backend's routines, grouped by the Bot that owns them.
 *
 * A backend with no routine concept says so in its own quiet line — never a
 * failure, never a zero. Only a read that really failed is red, and it carries
 * the Gate's reason beside a Retry. Which backend answered what is a per-host
 * fact, so each row names its backend and every backend gets a coverage line.
 */
export function RoutinesSection({ reloadSignal = 0 }: { reloadSignal?: number }) {
  const { activeGateway, activityFeed, status } = useGateway();
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
  const [openRunId, setOpenRunId] = useState<string | null>(null);
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
          {feed.backends.length > 1 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              <Chip label="All" selected={!backendFilter} onPress={() => setBackendFilter(undefined)} />
              {feed.backends.map((backend) => (
                <Chip
                  key={backend.id}
                  label={backend.label}
                  selected={backendFilter === backend.id}
                  onPress={() => setBackendFilter(backend.id)}
                />
              ))}
            </ScrollView>
          ) : null}
          {[...groups.entries()].map(([botId, routines]) => (
            <View key={botId ?? 'gateway'} style={styles.group}>
              {groups.size > 1 || botId ? (
                <Text variant="micro" color="secondary">{botId ? `Bot ${botId}` : 'Gateway'}</Text>
              ) : null}
              {routines.map((routine) => (
                <ListRow
                  key={`${routine.backendId}:${routine.id}`}
                  title={routine.name}
                  subtitle={routineJobSummary(routine)}
                  onPress={() => setOpenJob(routineJobView(routine))}
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
            const line = coverageLine(coverage, counts.get(coverage.id) ?? 0);
            return (
              <View key={coverage.id} style={styles.coverage}>
                <Text variant="caption" color={line.failed ? 'statusDisconnected' : 'tertiary'} style={styles.coverageText}>
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
        key={openJob?.id ?? 'no-job'}
        // Hide while a run transcript is open so two BaseSheets do not stack.
        job={openRunId ? null : openJob}
        onClose={() => setOpenJob(null)}
        onOpenRun={(runId) => setOpenRunId(runId)}
        onRemoved={() => {
          setOpenJob(null);
          void read();
        }}
        onChanged={() => void read()}
      />
      <CronRunSheet key={openRunId ?? 'no-run'} runId={openRunId} onClose={() => setOpenRunId(null)} />
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

/** One routine in the sheet's CronJob shape, so editing stays where it was. */
function routineJobView(routine: RoutineEntry): CronJob {
  return cronJobViewFromRoutine({
    id: routine.id,
    name: routine.name,
    paused: routine.paused,
    schedule: routine.schedule,
    lastStatus: routine.lastStatus,
    nextRunAt: routine.nextRunAt,
  });
}

function backendLabel(backends: readonly ActivityCoverage[], id: string): string {
  return backends.find((backend) => backend.id === id)?.label ?? id;
}

/**
 * One backend's coverage, in its own words: a real count, a plain none, a
 * neutral "not supported here", or a failure that carries the Gate's reason.
 */
function coverageLine(coverage: ActivityCoverage, count: number): { text: string; failed: boolean } {
  const routines = count === 1 ? '1 routine' : `${count} routines`;
  switch (coverage.status) {
    case 'complete':
      return { text: count > 0 ? routines : 'none', failed: false };
    case 'partial':
      return { text: `${routines} · ${coverage.error ?? 'some could not be read'}`, failed: false };
    case 'unavailable':
      return { text: 'not supported here', failed: false };
    case 'failed':
      return { text: coverage.error ?? 'could not be read', failed: true };
  }
}

const styles = StyleSheet.create({
  root: { gap: Spacing.three },
  group: { gap: Spacing.two },
  row: { marginBottom: Spacing.one },
  chips: { gap: Spacing.two },
  coverage: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.two },
  coverageText: { flex: 1, minWidth: 0 },
  skeleton: { gap: Spacing.two },
});
