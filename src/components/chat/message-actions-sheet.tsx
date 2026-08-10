import * as Clipboard from 'expo-clipboard';
import { StyleSheet, View } from 'react-native';

import { BaseSheet, Divider, ListRow, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { formatClockTime } from '@/lib/format';
import { haptics } from '@/lib/haptics';
import type { ChatMessage, CommandTranscriptEntry } from '@/lib/gateway/types';

export type MessageActionsSheetProps = {
  visible: boolean;
  message: ChatMessage | null;
  onClose: () => void;
  onRetry?: (entry: Partial<CommandTranscriptEntry> & { input: string }) => void;
  onDelete?: (id: string) => void;
};

/** Long-press action sheet for a chat message: copy, retry, delete, details. */
export function MessageActionsSheet({
  visible,
  message,
  onClose,
  onRetry,
  onDelete,
}: MessageActionsSheetProps) {
  if (!visible || !message) return null;

  const command = message.command;
  const canRetry = command?.status === 'error' && !!command.input && !!onRetry;
  const timeLabel = message.timestamp ? formatClockTime(message.timestamp) : undefined;

  const handleCopy = async () => {
    await Clipboard.setStringAsync(message.text);
    await haptics.success();
    onClose();
  };

  return (
    <BaseSheet visible={visible} eyebrow="MESSAGE" title="Message actions" onClose={onClose} closeLabel="Dismiss">
      <View style={styles.meta}>
        <Text variant="caption" color="tertiary">
          {message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Agent' : 'System'}
          {timeLabel ? ` · ${timeLabel}` : ''}
          {command?.title ? ` · ${command.title}` : ''}
        </Text>
      </View>

      <ListRow
        title="Copy text"
        icon={{ ios: 'doc.on.doc', android: 'content_copy', web: 'content_copy' }}
        chevron={false}
        onPress={() => void handleCopy()}
      />
      {canRetry ? (
        <ListRow
          title="Retry command"
          icon={{ ios: 'arrow.clockwise', android: 'refresh', web: 'refresh' }}
          chevron={false}
          onPress={() => {
            onRetry({ input: command.input!, title: command.title });
            onClose();
          }}
        />
      ) : null}
      {onDelete ? (
        <>
          <Divider />
          <ListRow
            title="Delete from view"
            icon={{ ios: 'trash', android: 'delete', web: 'delete' }}
            chevron={false}
            onPress={() => {
              void haptics.warning();
              onDelete(message.id);
              onClose();
            }}
            style={styles.destructive}
          />
        </>
      ) : null}
      <Text variant="micro" color="tertiary" style={styles.note}>
        Delete removes the message locally — the gateway keeps its history.
      </Text>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  meta: {
    paddingHorizontal: Spacing.two,
    paddingBottom: Spacing.one,
  },
  destructive: {
    marginTop: Spacing.one,
  },
  note: {
    paddingHorizontal: Spacing.two,
    paddingTop: Spacing.one,
  },
});
