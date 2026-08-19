import { StyleSheet, View } from 'react-native';

import { SessionAnalytics } from '@/components/chat/session-analytics';
import { BaseSheet, Divider, ListRow, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { formatRelativeTime } from '@/lib/format';
import type { SessionUsageInput } from '@/lib/gateway/session-analytics';

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
  sessions?: SessionUsageInput[];
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
  sessions = [],
}: ChatOverflowSheetProps) {
  if (!visible) return null;

  return (
    <BaseSheet visible={visible} eyebrow="CHAT" title="Session &amp; connection" onClose={onClose} closeLabel="Dismiss">
      {session ? (
        <SessionAnalytics
          session={{
            input_tokens: session.totalTokens,
            output_tokens: 0,
            actual_cost_usd: session.costUsd,
          }}
          sessions={sessions}
          messageCount={session.messageCount}
        />
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
