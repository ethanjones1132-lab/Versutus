import { StyleSheet, View } from 'react-native';

import { BotAvatar } from '@/components/chat/bot-avatar';
import { PulsingDot } from '@/components/connection-badge';
import { Icon, PressableScale, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens, type Tokens } from '@/hooks/use-tokens';
import { formatRelativeTime } from '@/lib/format';
import { runStatusCopy, runsForGlance, type RunStatusTone } from '@/lib/gateway/run-status-copy';
import type { ActivityRun } from '@/lib/gateway/runs';
import { haptics } from '@/lib/haptics';

/** How many runs the Activity glance shows before "See all" takes over. */
export const RECENT_RUNS_LIMIT = 4;

function toneColor(tokens: Tokens, tone: RunStatusTone): string {
  switch (tone) {
    case 'live':
      return tokens.accent;
    case 'attention':
      return tokens.statusConnecting;
    case 'done':
      return tokens.statusConnected;
    case 'failed':
      return tokens.statusDisconnected;
    default:
      return tokens.textTertiary;
  }
}

/**
 * The runs worth a glance, on one surface: anything waiting on the operator
 * first, then anything still working, then the newest finished. Each row is
 * the Bot that ran it, what was asked, and where it stands. A tap opens the
 * full Runs screen, which owns the transcript and the controls.
 */
export function RecentRuns({
  runs,
  onOpenRuns,
}: {
  runs: ActivityRun[];
  onOpenRuns: () => void;
}) {
  const tokens = useTokens();
  const shown = runsForGlance(runs, RECENT_RUNS_LIMIT);

  if (shown.length === 0) {
    return (
      <View style={[styles.group, styles.empty, { backgroundColor: tokens.backgroundElevated }]}>
        <Text variant="caption" color="secondary">
          No runs yet. Ask a Bot to do something and it shows up here.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.group, { backgroundColor: tokens.backgroundElevated }]}>
      {shown.map((run, index) => {
        const status = runStatusCopy(run.status);
        const color = toneColor(tokens, status.tone);
        return (
          <PressableScale
            key={run.id}
            onPress={async () => {
              await haptics.selection();
              onOpenRuns();
            }}
            accessibilityRole="button"
            accessibilityLabel={`${run.prompt}. ${status.label}, ${formatRelativeTime(run.startedAt)}. Open runs.`}
            style={[
              styles.row,
              index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: tokens.borderSubtle } : null,
            ]}>
            {run.botId ? (
              <BotAvatar botId={run.botId} size={32} />
            ) : (
              <View style={[styles.directTile, { backgroundColor: tokens.accentMuted }]}>
                <Icon name={{ ios: 'sparkles', android: 'auto_awesome', web: 'auto_awesome' }} size={15} color="accent" />
              </View>
            )}
            <View style={styles.text}>
              <Text variant="body" numberOfLines={1} style={styles.prompt}>
                {run.prompt}
              </Text>
              <View style={styles.meta}>
                {status.tone === 'live' ? (
                  <PulsingDot color={color} active />
                ) : (
                  <View style={[styles.dot, { backgroundColor: color }]} />
                )}
                <Text variant="caption" style={{ color }}>
                  {status.label}
                </Text>
                <Text variant="caption" color="tertiary">
                  · {formatRelativeTime(run.startedAt)}
                </Text>
              </View>
            </View>
          </PressableScale>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    borderRadius: Radius.lg,
    overflow: 'hidden',
  },
  empty: {
    padding: Spacing.three,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three - 4,
    paddingHorizontal: Spacing.three - 2,
    paddingVertical: Spacing.three - 4,
    minHeight: 60,
  },
  directTile: {
    width: 32,
    height: 32,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  prompt: {
    fontSize: 15,
    lineHeight: 20,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + 2,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
});
