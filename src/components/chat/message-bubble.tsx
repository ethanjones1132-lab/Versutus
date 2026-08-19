import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { MarkdownText } from '@/components/chat/markdown/markdown-text';
import { StreamingIndicator } from '@/components/chat/streaming-indicator';
import { ToolCallCard } from '@/components/chat/tool-call-card';
import { Badge, Card, PressableScale, Text } from '@/components/ui';
import { FontFamily, Radius, Spacing } from '@/constants/tokens';
import { entering } from '@/lib/motion/presets';
import { formatClockTime } from '@/lib/format';
import { useTokens } from '@/hooks/use-tokens';
import type { ChatMessage, CommandTranscriptEntry } from '@/lib/gateway/types';

type MessageBubbleProps = {
  message: ChatMessage;
  onRetry?: (entry: Partial<CommandTranscriptEntry> & { input: string }) => void;
  onCancel?: (id: string) => void;
  /** Resume an assistant bubble left interrupted by a mid-stream disconnect. */
  onResume?: (message: ChatMessage) => void;
  /** Long-press opens the message action sheet. */
  onLongPress?: (message: ChatMessage) => void;
  /** Gateway display name; its initial becomes the assistant monogram. */
  identity?: string;
};

const COMMAND_STATUS_LABEL = {
  running: 'Running',
  complete: 'Done',
  error: 'Failed',
} as const;

const COMMAND_STATUS_TONE = {
  running: 'warning',
  complete: 'success',
  error: 'danger',
} as const;

export function MessageBubble({ message, onRetry, onCancel, onResume, onLongPress, identity }: MessageBubbleProps) {
  const tokens = useTokens();
  const isUser = message.role === 'user';
  const isCommand = !!message.command;
  const [rawOpen, setRawOpen] = useState(false);
  const commandStatus = message.command?.status;

  const duration = message.command?.durationMs
    ? `${Math.round(message.command.durationMs / 1000)}s`
    : undefined;

  const handleLongPress = async () => {
    if (!onLongPress) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onLongPress(message);
  };

  const body = message.streaming ? `${message.text} ▍` : message.text;
  const isInterrupted = !!message.interrupted;

  return (
    <Animated.View
      entering={isUser ? entering.slideInRight : entering.slideInLeft}
      style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      {!isUser && identity ? (
        <View
          style={[
            styles.monogram,
            { backgroundColor: tokens.backgroundInset, borderColor: tokens.glassBorder },
          ]}>
          <Text variant="micro" color="accentWarm" style={styles.monogramLetter}>
            {identity.slice(0, 1).toUpperCase()}
          </Text>
        </View>
      ) : null}
      <View style={[styles.bubbleColumn, isUser ? styles.bubbleColumnUser : styles.bubbleColumnAssistant]}>
        <PressableScale
          onLongPress={() => void handleLongPress()}
          delayLongPress={350}
          style={styles.bubblePress}>
        <Card
          variant={isUser ? 'chip' : 'surface'}
          padding={Spacing.three}
          style={[
            styles.bubble,
            isCommand && styles.commandBubble,
            isUser
              ? { backgroundColor: tokens.accentMuted, borderColor: tokens.accentWarm }
              : isInterrupted
                ? { borderColor: tokens.statusDisconnected }
                : message.streaming || commandStatus === 'running'
                  ? { borderColor: tokens.accentWarmMuted }
                  : commandStatus === 'error'
                    ? { borderColor: tokens.statusDisconnected }
                    : { borderColor: tokens.glassBorder },
          ]}>
          {message.queued ? (
            <Badge label="Queued" tone="warning" dot={false} />
          ) : null}

          {isCommand ? (
            <View style={styles.commandHeader}>
              <View style={styles.commandTitle}>
                <Text variant="caption" color="secondary" numberOfLines={1} style={styles.commandTitleText}>
                  {message.command?.title ?? 'Command'}
                </Text>
                {message.command?.ephemeral ? (
                  <Text variant="micro" color="tertiary">
                    Local
                  </Text>
                ) : null}
              </View>
              <Badge
                label={COMMAND_STATUS_LABEL[commandStatus ?? 'complete']}
                tone={COMMAND_STATUS_TONE[commandStatus ?? 'complete']}
              />
            </View>
          ) : null}

          {message.toolCalls?.map((toolCall, index) => (
            <ToolCallCard key={`${toolCall.name}-${index}`} toolCall={toolCall} />
          ))}

          {isInterrupted ? (
            <Badge label="Interrupted" tone="warning" dot={false} />
          ) : null}

          {isCommand ? (
            <Text color="primary" variant="caption">
              {body}
            </Text>
          ) : isUser ? (
            <Text color="primary" variant="body">
              {message.text}
            </Text>
          ) : (
            <MarkdownText text={body} />
          )}

          {isInterrupted && onResume ? (
            <PressableScale
              onPress={async () => {
                await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onResume(message);
              }}
              style={styles.actionButton}>
              <Text variant="caption" color="accent">
                Resume
              </Text>
            </PressableScale>
          ) : null}

          {message.command?.raw ? (
            <View style={styles.rawSection}>
              <PressableScale onPress={() => setRawOpen((open) => !open)} style={styles.rawButton}>
                <Text variant="caption" color="accent">
                  {rawOpen ? 'Hide raw' : 'Raw'}
                </Text>
              </PressableScale>
              {rawOpen ? (
                <View
                  style={[
                    styles.rawCard,
                    {
                      backgroundColor: tokens.backgroundInset,
                      borderColor: tokens.glassBorder,
                    },
                  ]}>
                  <ScrollView style={styles.rawScroll} nestedScrollEnabled>
                    <Text variant="mono" color="secondary">
                      {message.command.raw}
                    </Text>
                  </ScrollView>
                </View>
              ) : null}
            </View>
          ) : null}

          {isCommand && (duration || (commandStatus === 'error' && onRetry) || (commandStatus === 'running' && onCancel)) ? (
            <View style={styles.commandActions}>
              {duration ? (
                <Text variant="micro" color="tertiary">
                  {duration}
                </Text>
              ) : null}
              {commandStatus === 'error' && onRetry && message.command?.input ? (
                <PressableScale
                  onPress={async () => {
                    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    onRetry({
                      input: message.command!.input!,
                      title: message.command?.title,
                    });
                  }}
                  style={styles.actionButton}>
                  <Text variant="caption" color="accent">
                    Retry
                  </Text>
                </PressableScale>
              ) : null}
              {commandStatus === 'running' && onCancel ? (
                <PressableScale
                  onPress={async () => {
                    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    onCancel(message.id);
                  }}
                  style={styles.actionButton}>
                  <Text variant="caption" color="accent">
                    Cancel
                  </Text>
                </PressableScale>
              ) : null}
            </View>
          ) : null}

          {message.streaming || commandStatus === 'running' ? <StreamingIndicator /> : null}
        </Card>
        </PressableScale>
        {message.timestamp ? (
          <Text variant="micro" color="tertiary" style={styles.timestamp}>
            {formatClockTime(message.timestamp)}
          </Text>
        ) : null}
        </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.two,
  },
  rowUser: {
    justifyContent: 'flex-end',
  },
  rowAssistant: {
    justifyContent: 'flex-start',
  },
  monogram: {
    width: 26,
    height: 26,
    borderRadius: Radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.two,
  },
  monogramLetter: {
    fontFamily: FontFamily.sansSemiBold,
    fontSize: 11,
    lineHeight: 14,
  },
  bubbleColumn: {
    flexShrink: 1,
    minWidth: 0,
    gap: Spacing.half,
  },
  bubbleColumnUser: {
    alignItems: 'flex-end',
  },
  bubbleColumnAssistant: {
    alignItems: 'flex-start',
  },
  bubblePress: {
    maxWidth: '85%',
  },
  bubble: {
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.two,
  },
  commandBubble: {
    maxWidth: '100%',
    borderColor: 'rgba(240, 214, 144, 0.22)',
    padding: Spacing.two,
  },
  commandHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  commandTitle: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  commandTitleText: {
    flexShrink: 1,
  },
  rawSection: {
    gap: Spacing.two,
  },
  rawButton: {
    alignSelf: 'flex-start',
    minHeight: 28,
    justifyContent: 'center',
  },
  rawCard: {
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.two,
    maxHeight: 260,
  },
  rawScroll: {
    maxHeight: 240,
  },
  commandActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  actionButton: {
    paddingHorizontal: Spacing.one,
    paddingVertical: 2,
    minHeight: 28,
    justifyContent: 'center',
  },
  timestamp: {
    fontSize: 10,
    lineHeight: 13,
    fontFamily: FontFamily.mono,
    paddingHorizontal: Spacing.one,
  },
});
