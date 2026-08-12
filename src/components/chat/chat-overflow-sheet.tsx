import { StyleSheet, View } from 'react-native';

import { BaseSheet, Divider, ListRow, StatTile, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { formatCost, formatRelativeTime, formatTokenCount } from '@/lib/format';

export type ChatSessionStats = {
  title?: string | null;
  messageCount?: number;
  totalTokens?: number;
  costUsd?: number | null;
  lastActive?: number;
};

export type ChatOverflowSheetProps = {
  visible: boolean;
  onClose: () => void;
  session?: ChatSessionStats | null;
  onReloadHistory: () => void;
  onNewSession: () => void;
  onDisconnect: () => void;
  /** Prefill composer with /run when the gateway supports agentic runs. */
  onStartRun?: () => void;
  runsSupported?: boolean;
};

/** Chat header overflow: session usage at a glance + session/connection actions. */
export function ChatOverflowSheet({
  visible,
  onClose,
  session,
  onReloadHistory,
  onNewSession,
  onDisconnect,
  onStartRun,
  runsSupported = false,
}: ChatOverflowSheetProps) {
  if (!visible) return null;

  return (
    <BaseSheet visible={visible} eyebrow="CHAT" title="Session &amp; connection" onClose={onClose} closeLabel="Dismiss">
      {session ? (
        <View style={styles.stats}>
          <StatTile label="Messages" value={String(session.messageCount ?? 0)} />
          <StatTile label="Tokens" value={formatTokenCount(session.totalTokens ?? 0)} />
          <StatTile label="Cost" value={session.costUsd != null ? formatCost(session.costUsd) : '—'} />
        </View>
      ) : (
        <Text variant="caption" color="tertiary" style={styles.noSession}>
          No session stats yet — open the session selector to load them.
        </Text>
      )}
      {session?.lastActive ? (
        <Text variant="micro" color="tertiary" style={styles.lastActive}>
          Last active {formatRelativeTime(session.lastActive)}
        </Text>
      ) : null}

      <View style={styles.actions}>
        {runsSupported && onStartRun ? (
          <ListRow
            title="Run task"
            subtitle="Agentic run with approval gates → Activity"
            icon={{ ios: 'bolt.fill', android: 'bolt', web: 'bolt' }}
            chevron={false}
            onPress={() => {
              onStartRun();
              onClose();
            }}
          />
        ) : null}
        <ListRow
          title="Reload history"
          icon={{ ios: 'arrow.clockwise', android: 'refresh', web: 'refresh' }}
          chevron={false}
          onPress={() => {
            onReloadHistory();
            onClose();
          }}
        />
        <ListRow
          title="New session"
          icon={{ ios: 'plus.bubble', android: 'add_comment', web: 'add_comment' }}
          chevron={false}
          onPress={() => {
            onNewSession();
            onClose();
          }}
        />
        <Divider />
        <ListRow
          title="Disconnect gateway"
          icon={{ ios: 'power', android: 'power_settings_new', web: 'power_settings_new' }}
          chevron={false}
          onPress={() => {
            onDisconnect();
            onClose();
          }}
        />
      </View>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  stats: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingHorizontal: Spacing.one,
    paddingBottom: Spacing.two,
  },
  noSession: {
    paddingHorizontal: Spacing.two,
    paddingBottom: Spacing.two,
  },
  lastActive: {
    paddingHorizontal: Spacing.two,
    paddingBottom: Spacing.two,
  },
  actions: {
    gap: 0,
  },
});
