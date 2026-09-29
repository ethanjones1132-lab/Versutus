import { useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';

import { CommandHistorySection } from '@/components/chat/command-history-section';
import { SessionAnalytics } from '@/components/chat/session-analytics';
import { PulsingDot, statusColor, statusLabel } from '@/components/connection-badge';
import { BaseSheet, ConfirmSheet, ListRow, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import { formatRelativeTime } from '@/lib/format';
import type { ConnectionStatus } from '@/lib/gateway/types';
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
  /**
   * Connection status line. The header is one row (back · title · menu), so
   * this sheet is where the status chrome the header dropped lives.
   */
  status?: ConnectionStatus;
  statusDetail?: string;
  /** Current session title, captioning the Sessions row. */
  sessionLabel?: string;
  /** Opens the session selector. Present on a thread only. */
  onSessionsPress?: () => void;
  /** This conversation's read-aloud opt-in, and its toggle. Thread only. */
  speakerOn?: boolean;
  onSpeakerPress?: () => void;
  /** Settings entry, so the Chat chrome keeps one without a second header button. */
  onSettingsPress?: () => void;
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
};

/** Chat header overflow: session usage at a glance + session/connection actions. */
export function ChatOverflowSheet({
  visible,
  onClose,
  session,
  spendCopy,
  spendSession,
  status,
  statusDetail,
  sessionLabel,
  onSessionsPress,
  speakerOn,
  onSpeakerPress,
  onSettingsPress,
  onReloadHistory,
  onNewSession,
  onDisconnect,
  onStartRun,
  runsSupported = false,
  sessions = [],
  rowCount,
  onEditAgent,
}: ChatOverflowSheetProps) {
  const tokens = useTokens();
  // Disconnect arms a danger confirmation first — same pattern as session
  // delete and group disband — so the tap cannot drop the connection alone.
  const [disconnectArmed, setDisconnectArmed] = useState(false);
  if (!visible) return null;

  const lastActive = session?.lastActive ?? spendSession?.last_active;
  const statusPulsing =
    status === 'connecting' || status === 'reconnecting' || status === 'pairing';

  return (
    <>
      <BaseSheet visible={visible} eyebrow="CHAT" title="Session &amp; connection" onClose={onClose} closeLabel="Dismiss">
      {status ? (
        <View style={styles.status}>
          <PulsingDot color={statusColor(tokens, status)} active={statusPulsing} />
          <Text variant="caption" color="secondary" numberOfLines={1}>
            {statusLabel(status)}
            {statusDetail && status !== 'pairing' ? ` · ${statusDetail}` : ''}
          </Text>
        </View>
      ) : null}
      {spendSession ? (
        <SessionAnalytics
          session={spendSession}
          sessions={sessions}
          rowCount={rowCount}
          messageCount={session?.messageCount}
          lastActive={lastActive}
        />
      ) : spendCopy ? (
        <Text variant="caption" color="tertiary" style={styles.noSession}>
          {spendCopy}
        </Text>
      ) : null}
      {!spendSession && lastActive ? (
        <Text variant="micro" color="tertiary" style={styles.lastActive}>
          Last active {formatRelativeTime(lastActive)}
        </Text>
      ) : null}

      {/* What this conversation can do, as one grouped well; the app-level
          door and the one row that ends something each stand apart. */}
      <Text variant="caption" color="secondary" style={styles.groupLabel}>
        This conversation
      </Text>
      <View style={[styles.group, { backgroundColor: tokens.backgroundInset }]}>
        {onSessionsPress ? (
          <ListRow
            title="Sessions"
            subtitle={sessionLabel}
            icon={{ ios: 'bubble.left.and.bubble.right', android: 'chat', web: 'chat' }}
            chevron={false}
            onPress={() => {
              onSessionsPress();
              onClose();
            }}
          />
        ) : null}
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
        {onSpeakerPress ? (
          // A setting, so a switch: flipping it leaves the sheet open, the way
          // every other on/off in the app behaves.
          <ListRow
            title="Read replies aloud"
            subtitle={speakerOn ? 'On' : 'Off'}
            icon={{
              ios: speakerOn ? 'speaker.wave.2.fill' : 'speaker.slash.fill',
              android: speakerOn ? 'volume_up' : 'volume_off',
              web: speakerOn ? 'volume_up' : 'volume_off',
            }}
            chevron={false}
            onPress={onSpeakerPress}
            trailing={
              <Switch
                value={speakerOn === true}
                onValueChange={() => onSpeakerPress()}
                trackColor={{ true: tokens.accentDeep, false: tokens.backgroundRaised }}
                thumbColor={tokens.textPrimary}
                accessibilityLabel="Read replies aloud"
                accessibilityState={{ checked: speakerOn === true }}
              />
            }
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
      </View>

      <CommandHistorySection />

      <View style={[styles.group, { backgroundColor: tokens.backgroundInset }]}>
        {onSettingsPress ? (
          <ListRow
            title="Settings"
            icon={{ ios: 'gearshape', android: 'settings', web: 'settings' }}
            chevron
            onPress={() => {
              onSettingsPress();
              onClose();
            }}
          />
        ) : null}
        <ListRow
          title="Disconnect gateway"
          icon={{ ios: 'power', android: 'power_settings_new', web: 'power_settings_new' }}
          tone="danger"
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
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.two,
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
  groupLabel: {
    paddingHorizontal: Spacing.two,
    paddingBottom: Spacing.one,
  },
  group: {
    borderRadius: Radius.lg,
    overflow: 'hidden',
    paddingVertical: Spacing.one,
    marginBottom: Spacing.three,
  },
});
