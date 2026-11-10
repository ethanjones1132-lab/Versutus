import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { ActivityRow } from '@/components/activity/activity-row';
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
  onOpenSession: (sessionId: string) => void;
}) {
  const { activityFeed, status, activityRunsForActiveGateway, pendingApprovals, pendingRunApproval, resolveRunApproval, listBots } = useGateway();
  const [state, setState] = useState<ActivityState>(EMPTY_ACTIVITY_STATE);
  const [bots, setBots] = useState<PublicBot[]>([]);
  const [backendFilter, setBackendFilter] = useState<string | undefined>();
  const requestId = useRef(0);
  const inFlight = useRef<{ settled: boolean; promise: Promise<void> } | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void listBots().then((result) => { if (mounted.current) setBots(result); }).catch(() => undefined);
    return () => { mounted.current = false; };
  }, [listBots]);

  const read = useCallback((): Promise<void> => {
    if (status !== 'connected') return Promise.resolve();
    const active = inFlight.current;
    if (active && !active.settled) return active.promise;
    const id = ++requestId.current;
    const ticket = { settled: false, promise: Promise.resolve() };
    inFlight.current = ticket;
    ticket.promise = (async () => {
      try {
        const feed = await activityFeed.readActivity({ since: todaySince() });
        if (mounted.current && id === requestId.current) setState((previous) => applyActivityRead(previous, { ok: true, feed }));
      } catch (caught) {
        if (mounted.current && id === requestId.current) {
          setState((previous) => applyActivityRead(previous, { ok: false, error: caught instanceof Error ? caught.message : String(caught) }));
        }
      } finally {
        ticket.settled = true;
        if (inFlight.current === ticket) inFlight.current = null;
      }
    })();
    return ticket.promise;
  }, [activityFeed, status]);

  useEffect(() => {
    const timer = setTimeout(() => { void read(); }, 0);
    return () => clearTimeout(timer);
  }, [read, reloadSignal]);

  const feed = state.feed;
  const since = todaySince();
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
