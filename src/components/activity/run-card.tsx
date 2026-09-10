import { memo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Badge, Card, Icon, PressableScale, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { useNow } from '@/hooks/use-now';
import { watchedRunSpanMs } from '@/lib/fleet/scorecard';
import { formatDuration, formatRelativeTime } from '@/lib/format';
import { haptics } from '@/lib/haptics';
import type { ActivityRun } from '@/lib/gateway/runs';

const STATUS_LABEL: Record<ActivityRun['status'], string> = {
  running: 'Running',
  'waiting-approval': 'Needs approval',
  complete: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
  unresolved: 'Unconfirmed',
};

const STATUS_TONE: Record<ActivityRun['status'], 'warning' | 'accent' | 'success' | 'danger' | 'neutral'> = {
  running: 'warning',
  'waiting-approval': 'accent',
  complete: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  unresolved: 'warning',
};

export type RunCardProps = {
  run: ActivityRun;
  onStop?: (runId: string) => void;
  /**
   * Open the agentic-run transcript sheet for this run. Rendered only on
   * finished runs (a live run is already streaming its events through the
   * preview line and benefits from the in-memory summary, not a full replay).
   * Optional, so the live card stays byte-identical with the previous shape.
   */
  onOpenTranscript?: (runId: string) => void;
  /**
   * Re-run a failed / cancelled / unresolved run with the same prompt. Hidden
   * on live runs and on completed runs (an idempotent retry would just redo
   * finished work) and on runs whose prompt is empty or whitespace (there is
   * nothing to re-send). Mirrors the Activity "Start a run" card, which routes
   * through the `/run` slash command, so a Retry lands on the same code path
   * the operator reaches from chat.
   */
  onRetry?: (prompt: string) => void;
};

/** Ticking elapsed label for a live run; the only per-second re-render in the card. */
function LiveElapsed({ startedAt }: { startedAt: number }) {
  const now = useNow(1000, true);
  return (
    <Text variant="micro" color="tertiary">
      {formatDuration(now - startedAt)}
    </Text>
  );
}

/** Live run monitor card: status, elapsed, latest event, expandable event log. */
export const RunCard = memo(function RunCard({ run, onStop, onOpenTranscript, onRetry }: RunCardProps) {
  const tokens = useTokens();
  const [expanded, setExpanded] = useState(false);
  const live = run.status === 'running' || run.status === 'waiting-approval';
  const latestEvent = run.events.length > 0 ? run.events[run.events.length - 1] : null;
  /**
   * The span this card may print, or `null` for a run this device never watched
   * end. It is the fold's own rule (`watchedRunSpanMs`, the one the Bot
   * scorecards count a median over) rather than a second copy of it on this
   * surface: a row restored from disk carries no finish of its own — the load
   * stamps one at read time (`normalizeRestoredRuns`) — so an `unresolved` row
   * would otherwise show how long the APP was closed as how long the RUN took.
   * Its own status says this device never learned the end of it (`runs.ts:25-30`).
   */
  const span = watchedRunSpanMs(run);

  return (
    <Card
      variant={live ? 'surface' : 'inset'}
      padding={Spacing.three}
      style={[
        styles.card,
        {
          borderColor:
            run.status === 'waiting-approval'
              ? tokens.accentWarm
              : run.status === 'failed'
                ? tokens.statusDisconnected
                : live
                  ? tokens.accentWarmMuted
                  : tokens.borderSubtle,
        },
      ]}>
      <View style={styles.header}>
        <Badge label={STATUS_LABEL[run.status]} tone={STATUS_TONE[run.status]} />
        {live ? (
          <LiveElapsed startedAt={run.startedAt} />
        ) : (
          <Text variant="micro" color="tertiary">
            {span === null ? '' : `${formatDuration(span)} · `}
            {formatRelativeTime(run.finishedAt ?? run.startedAt)}
          </Text>
        )}
      </View>

      <Text variant="body" numberOfLines={expanded ? undefined : 2}>
        {run.prompt}
      </Text>

      {live && latestEvent ? (
        <View style={[styles.ticker, { backgroundColor: tokens.backgroundInset, borderColor: tokens.borderSubtle }]}>
          <Text variant="mono" color="secondary" numberOfLines={2}>
            {latestEvent.preview || latestEvent.type}
          </Text>
        </View>
      ) : null}

      {!live && run.summary ? (
        <Text variant="caption" color="secondary" numberOfLines={expanded ? undefined : 2}>
          {run.summary}
        </Text>
      ) : null}

      {expanded && run.events.length > 0 ? (
        <ScrollView
          style={[styles.eventLog, { backgroundColor: tokens.backgroundInset, borderColor: tokens.borderSubtle }]}
          nestedScrollEnabled>
          {run.events.map((event, index) => (
            <Text key={index} variant="mono" color="tertiary" style={styles.eventLine}>
              {event.type}: {event.preview}
            </Text>
          ))}
        </ScrollView>
      ) : null}

      <View style={styles.actions}>
        {run.events.length > 0 ? (
          <PressableScale
            onPress={async () => {
              await haptics.selection();
              setExpanded((open) => !open);
            }}
            accessibilityRole="button"
            accessibilityLabel={expanded ? 'Hide event log' : 'Show event log'}
            accessibilityState={{ expanded }}
            style={styles.actionButton}>
            <Icon
              name={expanded ? { ios: 'chevron.up', android: 'expand_less', web: 'expand_less' } : { ios: 'chevron.down', android: 'expand_more', web: 'expand_more' }}
              size={12}
              color="accent"
            />
            <Text variant="caption" color="accent">
              {expanded ? 'Hide events' : `${run.events.length} events`}
            </Text>
          </PressableScale>
        ) : null}
        {live && onStop ? (
          <PressableScale
            onPress={async () => {
              await haptics.warning();
              onStop(run.id);
            }}
            accessibilityRole="button"
            accessibilityLabel="Stop run"
            style={styles.actionButton}>
            <Icon name={{ ios: 'stop.fill', android: 'stop', web: 'stop' }} size={11} color="statusDisconnected" />
            <Text variant="caption" color="statusDisconnected">
              Stop run
            </Text>
          </PressableScale>
        ) : null}
        {!live && onOpenTranscript ? (
          <PressableScale
            onPress={async () => {
              await haptics.selection();
              onOpenTranscript(run.id);
            }}
            accessibilityRole="button"
            accessibilityLabel="View run transcript"
            style={styles.actionButton}>
            <Icon
              name={{ ios: 'list.bullet.rectangle', android: 'list', web: 'list' }}
              size={12}
              color="accent"
            />
            <Text variant="caption" color="accent">
              View transcript
            </Text>
          </PressableScale>
        ) : null}
        {!live && onRetry && run.status !== 'complete' && run.prompt.trim() ? (
          <PressableScale
            onPress={async () => {
              await haptics.selection();
              onRetry(run.prompt);
            }}
            accessibilityRole="button"
            accessibilityLabel="Retry run"
            style={styles.actionButton}>
            <Icon
              name={{ ios: 'arrow.clockwise', android: 'refresh', web: 'refresh' }}
              size={12}
              color="accent"
            />
            <Text variant="caption" color="accent">
              Retry run
            </Text>
          </PressableScale>
        ) : null}
      </View>
    </Card>
  );
});

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.two,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  ticker: {
    borderRadius: Radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  eventLog: {
    borderRadius: Radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.two,
    maxHeight: 200,
  },
  eventLine: {
    paddingVertical: 1,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    minHeight: 44,
  },
});
