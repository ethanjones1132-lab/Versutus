import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Badge, Card, Icon, PressableScale, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { useNow } from '@/hooks/use-now';
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
};

/** Live run monitor card: status, elapsed, latest event, expandable event log. */
export function RunCard({ run, onStop }: RunCardProps) {
  const tokens = useTokens();
  const [expanded, setExpanded] = useState(false);
  const live = run.status === 'running' || run.status === 'waiting-approval';
  const now = useNow(1000, live);

  const elapsed = formatDuration((run.finishedAt ?? now) - run.startedAt);
  const latestEvent = run.events.length > 0 ? run.events[run.events.length - 1] : null;

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
        <Text variant="micro" color="tertiary">
          {live ? elapsed : `${elapsed} · ${formatRelativeTime(run.finishedAt ?? run.startedAt)}`}
        </Text>
      </View>

      <Text variant="body" numberOfLines={expanded ? undefined : 2}>
        {run.prompt}
      </Text>

      {live && latestEvent ? (
        <View style={[styles.ticker, { backgroundColor: tokens.backgroundInset, borderColor: tokens.borderSubtle }]}>
          <Text variant="mono" color="secondary" numberOfLines={1}>
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
      </View>
    </Card>
  );
}

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
    minHeight: 30,
  },
});
