import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { CommandHistorySection } from '@/components/chat/command-history-section';
import { SessionAnalytics } from '@/components/chat/session-analytics';
import { BaseSheet, ConfirmSheet, Divider, ListRow, Text } from '@/components/ui';
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
  /** Glance-fold copy. Failed reads only — meters render spendSession. */
  spendCopy?: string;
  /** This thread's sessions.list row. Input and output stay separate. */
  spendSession?: SessionUsageInput | null;
  onReloadHistory: () => void;
  onNewSession: () => void;
  onDisconnect: () => void;
  /** Prefill composer with /run when the gateway supports agentic runs. */
  onStartRun?: () => void;
  runsSupported?: boolean;
  sessions?: SessionUsageInput[];
  /** Present on a Bot's own chat — opens the edit sheet for that agent. */
  onEditAgent?: () => void;
};

/** Chat header overflow: session usage at a glance + session/connection actions. */
export function ChatOverflowSheet({
  visible,
  onClose,
  session,
  spendCopy,
  spendSession,
  onReloadHistory,
  onNewSession,
  onDisconnect,
  onStartRun,
  runsSupported = false,
  sessions = [],
  onEditAgent,
}: ChatOverflowSheetProps) {
  // Disconnect arms a danger confirmation first — same pattern as session
  // delete and group disband — so the tap cannot drop the connection alone.
  const [disconnectArmed, setDisconnectArmed] = useState(false);
  if (!visible) return null;

  const lastActive = session?.lastActive ?? spendSession?.last_active;

  return (
    <>
      <BaseSheet visible={visible} eyebrow="CHAT" title="Session &amp; connection" onClose={onClose} closeLabel="Dismiss">
      {spendSession ? (
        <SessionAnalytics
          session={spendSession}
          sessions={sessions}
          messageCount={session?.messageCount}
        />
      ) : spendCopy ? (
        <Text variant="caption" color="tertiary" style={styles.noSession}>
          {spendCopy}
        </Text>
      ) : null}
      {lastActive ? (
        <Text variant="micro" color="tertiary" style={styles.lastActive}>
          Last active {formatRelativeTime(lastActive)}
        </Text>
      ) : null}
      <CommandHistorySection />

      <View style={styles.actions}>
        {onEditAgent ? (
          <ListRow
            title="Edit agent"
            subtitle="Description, soul, and model pin"
            icon={{ ios: 'pencil', android: 'edit', web: 'edit' }}
            chevron={false}
            onPress={() => {
              onEditAgent();
              onClose();
            }}
          />
        ) : null}
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
            setDisconnectArmed(true);
          }}
        />
      </View>
      </BaseSheet>
      <ConfirmSheet
        visible={disconnectArmed}
        title="Disconnect gateway?"
        message="The gateway connection drops and this Chat clears its messages until you connect again."
        confirmLabel="Disconnect gateway"
        danger
        onCancel={() => setDisconnectArmed(false)}
        onConfirm={() => {
          setDisconnectArmed(false);
          onDisconnect();
          onClose();
        }}
      />
    </>
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
