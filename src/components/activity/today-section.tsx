import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, ScrollView, StyleSheet, View } from 'react-native';

import { ActivityRow, type ActivitySessionTarget } from '@/components/activity/activity-row';
import { ApprovalDecisionCard } from '@/components/activity/approval-decision-card';
import { ApprovalInbox } from '@/components/activity/approval-inbox';
import { RecentRuns } from '@/components/activity/recent-runs';
import { Card, Chip, ErrorCard, SectionHeader, Skeleton, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { filterActivityByBackend, groupActivityForToday, liveRunsForToday } from '@/lib/activity/today';
import {
  activityCounts,
  applyActivityRead,
  coverageNotice,
  EMPTY_ACTIVITY_STATE,
  todaySince,
  type ActivityState,
} from '@/lib/gateway/activity-feed';
import type { PublicBot } from '@/lib/gateway/bots';

export function TodaySection({
  reloadSignal,
  onOpenRun,
  onOpenSession,
}: {
  reloadSignal: number;
  onOpenRun: (runId: string) => void;
  onOpenSession: (target: ActivitySessionTarget) => void;
}) {
  const { activeGateway, activityFeed, status, activityRunsForActiveGateway, pendingApprovals, pendingRunApproval, resolveRunApproval, listBots } = useGateway();
  // The feed, roster, filter and every open read belong to one Gate. Keying
  // the rendered state to this id is what stops a late answer from the Gate we
  // just left painting under the one on screen.
  const gatewayId = activeGateway?.id;
  // The day the read covers, re-derived at local midnight and on resume rather
  // than frozen at whichever day the screen happened to mount.
  const [since, setSince] = useState(() => todaySince());
  const [ownedState, setOwnedState] = useState<{ gatewayId?: string; state: ActivityState }>({
    gatewayId,
    state: EMPTY_ACTIVITY_STATE,
  });
  const state = ownedState.gatewayId === gatewayId ? ownedState.state : EMPTY_ACTIVITY_STATE;
  const [bots, setBots] = useState<PublicBot[]>([]);
  const [backendFilter, setBackendFilter] = useState<string | undefined>();
  const requestId = useRef(0);
  const inFlight = useRef<{
    settled: boolean;
    promise: Promise<void>;
    since: string;
    gatewayId?: string;
  } | null>(null);
  const mounted = useRef(true);
  const gatewayIdRef = useRef(gatewayId);

  const dayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armDayTimerRef = useRef<() => void>(() => undefined);
  const armDayTimer = useCallback(() => {
    if (dayTimer.current) clearTimeout(dayTimer.current);
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    // One timer to the next local midnight, then re-armed from its own
    // callback so it keeps running without a polling loop.
    dayTimer.current = setTimeout(() => {
      dayTimer.current = null;
      setSince(todaySince());
      armDayTimerRef.current();
    }, Math.max(0, next.getTime() - now.getTime()) + 1_000);
  }, []);
  useEffect(() => {
    armDayTimerRef.current = armDayTimer;
  }, [armDayTimer]);

  // A Gate switch is a change of owner for every row: retire the read still
  // in flight so the new Gate cannot join it, and clear what the previous one
  // left on screen. Deferred a tick because a loader effect that writes state
  // synchronously trips react-hooks/set-state-in-effect.
  useEffect(() => {
    gatewayIdRef.current = gatewayId;
    requestId.current += 1;
    inFlight.current = null;
    const timer = setTimeout(() => {
      if (gatewayIdRef.current !== gatewayId) return;
      setOwnedState({ gatewayId, state: EMPTY_ACTIVITY_STATE });
      setBots([]);
      setBackendFilter(undefined);
    }, 0);
    return () => clearTimeout(timer);
  }, [gatewayId]);

  useEffect(() => {
    mounted.current = true;
    const gateId = gatewayId;
    // Deferred so the switch's clear runs first; otherwise a fast roster read
    // could land before the clear and be wiped by it.
    const timer = setTimeout(() => {
      void listBots()
        .then((result) => {
          // The roster is the Gate's too: a reply from the one we left must
          // not name its Bots under the new Gate's rows.
          if (mounted.current && gatewayIdRef.current === gateId) setBots(result);
        })
        .catch(() => undefined);
    }, 0);
    return () => {
      mounted.current = false;
      clearTimeout(timer);
    };
  }, [gatewayId, listBots]);

  const read = useCallback((): Promise<void> => {
    if (status !== 'connected') return Promise.resolve();
    const gateId = gatewayId;
    const active = inFlight.current;
    // Join a read only when it covers the same Gate and the same day: a read
    // opened before midnight cannot answer the new day's question.
    if (active && !active.settled && active.since === since && active.gatewayId === gatewayId) {
      return active.promise;
    }
    const id = ++requestId.current;
    const ticket = { settled: false, promise: Promise.resolve(), since, gatewayId };
    inFlight.current = ticket;
    ticket.promise = (async () => {
      try {
        const feed = await activityFeed.readActivity({ since });
        if (mounted.current && id === requestId.current && gateId === gatewayIdRef.current) {
          setOwnedState((previous) => ({
            gatewayId: gateId,
            state: applyActivityRead(
              previous.gatewayId === gateId ? previous.state : EMPTY_ACTIVITY_STATE,
              { ok: true, feed },
            ),
          }));
        }
      } catch (caught) {
        if (mounted.current && id === requestId.current && gateId === gatewayIdRef.current) {
          setOwnedState((previous) => ({
            gatewayId: gateId,
            state: applyActivityRead(
              previous.gatewayId === gateId ? previous.state : EMPTY_ACTIVITY_STATE,
              { ok: false, error: caught instanceof Error ? caught.message : String(caught) },
            ),
          }));
        }
      } finally {
        ticket.settled = true;
        if (inFlight.current === ticket) inFlight.current = null;
      }
    })();
    return ticket.promise;
  }, [activityFeed, gatewayId, since, status]);

  useEffect(() => {
    const timer = setTimeout(() => { void read(); }, 0);
    return () => clearTimeout(timer);
  }, [read, reloadSignal]);

  // The boundary is device-local: a phone that slept past midnight, or moved
  // timezone, is showing yesterday under a "Today" heading until this re-reads.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      armDayTimer();
      const boundary = todaySince();
      if (boundary !== since) {
        setSince(boundary);
        return;
      }
      void read();
    });
    return () => subscription.remove();
  }, [armDayTimer, read, since]);

  useEffect(() => {
    armDayTimer();
    return () => {
      if (dayTimer.current) clearTimeout(dayTimer.current);
      dayTimer.current = null;
    };
  }, [armDayTimer]);

  const feed = state.feed;
  useEffect(() => {
    if (backendFilter && feed && !feed.backends.some((backend) => backend.id === backendFilter)) setBackendFilter(undefined);
  }, [backendFilter, feed]);
  const visibleItems = feed ? filterActivityByBackend(feed.items, backendFilter) : [];
  const groups = feed ? groupActivityForToday(visibleItems, feed.backends, bots) : [];
  // The summary describes the rows on screen: a selected chip narrows both.
  const counts = activityCounts(visibleItems);
  // These are the app's own runs, not the Gate's archived environment runs the
  // feed carries, so they do not wait on a read and use the app's vocabulary.
  const liveRuns = liveRunsForToday(activityRunsForActiveGateway);
  const time = (stamp: number) => new Date(stamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

  // Pinned above the day's history, and shown before the first feed lands:
  // an approval is a decision now, not a row in a list.
  const needsYou = (
    <View style={styles.section}>
      <SectionHeader title="Needs you" />
      <ApprovalInbox />
      {pendingRunApproval ? (
        <ApprovalDecisionCard
          runId={pendingRunApproval.runId}
          prompt={pendingRunApproval.prompt}
          onResolve={(approved, feedback) => resolveRunApproval(approved, feedback)}
        />
      ) : null}
    </View>
  );
  const inProgress = liveRuns.length ? (
    <View style={styles.section}>
      <SectionHeader title="In progress" />
      <RecentRuns runs={liveRuns} onOpenRun={onOpenRun} />
    </View>
  ) : null;

  return (
    <View style={styles.root}>
      {needsYou}
      {inProgress}
      {!state.loaded && state.failed ? (
        <ErrorCard
          cause={state.error ?? 'Activity could not be read.'}
          affected="Today's activity"
          next="Retry the read."
          onRetry={() => void read()}
        />
      ) : null}
      {!state.loaded && !state.failed && status !== 'connected' ? (
        // A first read cannot happen offline. An endless skeleton would claim
        // one is still coming; the offline line says what is actually true.
        <Text variant="caption" color="tertiary">Connect to a gateway to see today&apos;s activity.</Text>
      ) : null}
      {!state.loaded && !state.failed && status === 'connected' ? (
        <Card variant="stage" padding={Spacing.three} style={styles.skeleton}>
          <Skeleton />
          <Skeleton width="72%" />
          <Skeleton width="52%" />
        </Card>
      ) : null}
      {feed ? (
        <>
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
          <Text variant="caption" color="secondary">
            {`${counts.runs} run${counts.runs === 1 ? '' : 's'} Â· ${counts.sessions} session${counts.sessions === 1 ? '' : 's'}${pendingApprovals.length ? ` Â· ${pendingApprovals.length} need you` : ''}`}
          </Text>
          {groups.map((group) => (
            <View key={group.key} style={styles.section}>
              <SectionHeader title={group.title} />
              {group.items.map((item) => (
                <ActivityRow
                  key={`${item.backendId}:${item.kind}:${item.id}`}
                  item={item}
                  onOpenRun={onOpenRun}
                  onOpenSession={onOpenSession}
                />
              ))}
            </View>
          ))}
          {state.loaded && !state.failed && visibleItems.length === 0 ? (
            <Text variant="caption" color="tertiary">
              {backendFilter ? 'Nothing since midnight on this backend.' : 'Nothing since midnight.'}
            </Text>
          ) : null}
          {state.failed && state.loaded ? (
            <Text variant="caption" color="tertiary">Could not refresh â€” showing the last read.</Text>
          ) : null}
          {status !== 'connected' && state.updatedAt ? (
            <Text variant="caption" color="tertiary">
              {`Last updated ${time(state.updatedAt)}${state.updatedAt < Date.parse(since) ? ' Â· Older than today' : ''}`}
            </Text>
          ) : null}
          {feed.truncated?.window ? <Text variant="caption" color="tertiary">Showing the last 7 days.</Text> : null}
          {feed.truncated?.items ? <Text variant="caption" color="tertiary">Showing the newest 500 entries.</Text> : null}
          {feed.backends.map((backend) => {
            const notice = coverageNotice(backend);
            return notice ? (
              <Text key={backend.id} variant="caption" color="tertiary">{`${backend.label}: ${notice}`}</Text>
            ) : null;
          })}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({ root: { gap: Spacing.three }, section: { gap: Spacing.two }, chips: { gap: Spacing.two }, skeleton: { gap: Spacing.two } });
