import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { CommandHistorySection } from '@/components/chat/command-history-section';
import { SessionAnalytics } from '@/components/chat/session-analytics';
import { BaseSheet, Button, ConfirmSheet, Divider, ListRow, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { formatRelativeTime } from '@/lib/format';
import type { SessionUsageInput } from '@/lib/gateway/session-analytics';
import { parseSpendCapInput, SPEND_CAP_LIMIT_COPY } from '@/lib/settings/spend-cap-verdict';

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
  /**
   * Rows the read behind `sessions` held, parsed or not — the count the
   * sparkline's window line is captioned from. Required so no surface can
   * render the caption from the rows that happened to parse.
   */
  rowCount: number;
  /** Present on a Bot's own chat — opens the edit sheet for that agent. */
  onEditAgent?: () => void;
  /**
   * The Bot id this surface can carry a spend cap for, when the scoped-spend
   * read is advertised — the same gate the per-Bot spend section uses. Absent
   * on a gateway that cannot read per-Bot spend, so the row never invites a
   * cap the pre-run gate could never judge.
   */
  spendCapBotId?: string;
  /**
   * Writes what the cap row's field holds (already parsed by the fold the
   * sheet shares with the store). The parent owns the store call; the sheet
   * owns only the input.
   */
  onSetSpendCap?: (botId: string, capUsd: number | null) => void;
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
  rowCount,
  onEditAgent,
  spendCapBotId,
  onSetSpendCap,
}: ChatOverflowSheetProps) {
  // Disconnect arms a danger confirmation first — same pattern as session
  // delete and group disband — so the tap cannot drop the connection alone.
  const [disconnectArmed, setDisconnectArmed] = useState(false);
  // The cap row's own input: whatever the operator typed, held until the
  // parent writes it. A blank field is a cleared cap, not an untouched one.
  const [spendCapDraft, setSpendCapDraft] = useState('');
  if (!visible) return null;

  const lastActive = session?.lastActive ?? spendSession?.last_active;

  return (
    <>
      <BaseSheet visible={visible} eyebrow="CHAT" title="Session &amp; connection" onClose={onClose} closeLabel="Dismiss">
      {spendSession ? (
        <SessionAnalytics
          session={spendSession}
          sessions={sessions}
          rowCount={rowCount}
          messageCount={session?.messageCount}
        />
      ) : spendCopy ? (
        <Text variant="caption" color="tertiary" style={styles.noSession}>
          {spendCopy}
        </Text>
      ) : null}
      {spendCapBotId && onSetSpendCap ? (
        <View style={styles.spendCap}>
          <Text variant="micro" color="tertiary">
            SPEND CAP
          </Text>
          <TextField
            value={spendCapDraft}
            onChangeText={setSpendCapDraft}
            placeholder="None set — e.g. $5.00"
            accessibilityLabel="Spend cap for this agent"
          />
          <Text variant="caption" color="tertiary">
            A blank cap clears it. {SPEND_CAP_LIMIT_COPY}
          </Text>
          <Button
            label="Save cap"
            size="sm"
            disabled={!spendCapDraft.trim()}
            onPress={() => {
              onSetSpendCap(spendCapBotId, parseSpendCapInput(spendCapDraft));
              setSpendCapDraft('');
              onClose();
            }}
          />
        </View>
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
  spendCap: {
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    paddingBottom: Spacing.two,
  },
});
