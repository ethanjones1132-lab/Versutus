import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { memo, useState } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { MarkdownText } from '@/components/chat/markdown/markdown-text';
import { StreamingIndicator } from '@/components/chat/streaming-indicator';
import { ToolCallCard } from '@/components/chat/tool-call-card';
import { Badge, PressableScale, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { bubbleMaxWidth } from '@/lib/motion/bubble-width';
import { CHIP_HIT_SLOP } from '@/lib/motion/chip-hit-slop';
import { entering } from '@/lib/motion/presets';
import { useTokens } from '@/hooks/use-tokens';
import { interruptedSendAgainLabel } from '@/lib/gateway/interrupted-copy';
import type { ChatMessage, CommandTranscriptEntry } from '@/lib/gateway/types';

type MessageBubbleProps = {
  message: ChatMessage;
  onRetry?: (entry: Partial<CommandTranscriptEntry> & { input: string }) => void;
  onCancel?: (id: string) => void;
  /** Resend the previous user turn after a mid-stream disconnect. */
  onResume?: (message: ChatMessage) => void;
  /** Long-press opens the message action sheet (copy, retry, delete, time). */
  onLongPress?: (message: ChatMessage) => void;
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

export const MessageBubble = memo(function MessageBubble({ message, onRetry, onCancel, onResume, onLongPress }: MessageBubbleProps) {
  const tokens = useTokens();
  const { width: windowWidth } = useWindowDimensions();
  const isUser = message.role === 'user';
  const isCommand = !!message.command;
  const columnMaxWidth = bubbleMaxWidth(windowWidth, false);
  const [rawOpen, setRawOpen] = useState(false);
  const hasReasoning = typeof message.reasoning === 'string' && message.reasoning.length > 0;
  const toolCallCount = message.toolCalls?.length ?? 0;
  const activityParts: string[] = [];
  if (toolCallCount > 0) {
    activityParts.push(toolCallCount === 1 ? 'Used 1 tool' : `Used ${toolCallCount} tools`);
  }
  if (hasReasoning) activityParts.push('Thinking');
  const activityLabel = activityParts.join(' · ');
  const hasActivity = activityParts.length > 0;
  const [activityUserOverride, setActivityUserOverride] = useState<boolean | null>(null);
  const activitySettled = !!message.streaming && message.text.length === 0;
  const isActivityOpen = activityUserOverride !== null ? activityUserOverride : activitySettled;
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
      <View
        style={[
          styles.bubbleColumn,
          isUser ? styles.bubbleColumnUser : styles.bubbleColumnAssistant,
          isUser ? { maxWidth: columnMaxWidth } : null,
        ]}>
        <PressableScale
          onLongPress={() => void handleLongPress()}
          delayLongPress={350}>
          <View
            style={[
              styles.bubble,
              isUser ? styles.userBubble : styles.assistantBubble,
              isUser ? { backgroundColor: tokens.backgroundRaised } : null,
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

          {!isUser && hasActivity ? (
            <View style={styles.activitySection}>
              <PressableScale
                onPress={async () => {
                  await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setActivityUserOverride((prev) => (prev !== null ? !prev : !activitySettled));
                }}
                accessibilityRole="button"
                accessibilityLabel={activityLabel}
                accessibilityState={{ expanded: isActivityOpen }}
                hitSlop={CHIP_HIT_SLOP}
                style={styles.activityToggle}>
                <Text variant="caption" color="secondary">
                  {activityLabel}
                  {isActivityOpen ? '' : ' ›'}
                </Text>
              </PressableScale>
              {isActivityOpen ? (
                <View
                  style={[
                    styles.activityCard,
                    {
                      backgroundColor: tokens.backgroundInset,
                      borderColor: tokens.border,
                    },
                  ]}>
                  {hasReasoning ? (
                    <ScrollView style={styles.reasoningScroll} nestedScrollEnabled>
                      <Text variant="caption" color="secondary">
                        {message.reasoning}
                      </Text>
                    </ScrollView>
                  ) : null}
                  {message.toolCalls?.map((toolCall, index) => (
                    <ToolCallCard key={`${toolCall.name}-${index}`} toolCall={toolCall} />
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}

          {isInterrupted ? (
            <Badge label="Interrupted" tone="warning" dot={false} />
          ) : null}
          {isInterrupted && message.interruptedReason ? (
            <Text variant="caption" color="tertiary" style={styles.interruptedReason}>
              {message.interruptedReason}
            </Text>
          ) : null}

          {isUser && (message.attachments?.length ?? 0) > 0 ? (
            <View style={styles.attachments}>
              {message.attachments!.map((attachment) => (
                <Image
                  key={attachment.uri}
                  source={{ uri: attachment.uri }}
                  style={styles.attachmentImage}
                  contentFit="cover"
                  accessibilityLabel={attachment.name ?? 'Attached image'}
                />
              ))}
            </View>
          ) : null}

          {isCommand ? (
            <MarkdownText text={body} compact streaming={!!message.streaming} />
          ) : isUser ? (
            <Text color="primary" variant="body">
              {message.text}
            </Text>
          ) : (
            <MarkdownText text={body} streaming={!!message.streaming} />
          )}

          {isInterrupted && onResume ? (
            <PressableScale
              onPress={async () => {
                await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onResume(message);
              }}
              hitSlop={CHIP_HIT_SLOP}
              style={styles.actionButton}>
              <Text variant="caption" color="accent">
                {interruptedSendAgainLabel()}
              </Text>
            </PressableScale>
          ) : null}

          {!isCommand && !isInterrupted && !message.streaming && !isUser && onResume && message.text.startsWith('Error:') ? (
            <PressableScale
              onPress={async () => {
                await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onResume(message);
              }}
              hitSlop={CHIP_HIT_SLOP}
              style={styles.actionButton}>
              <Text variant="caption" color="accent">
                Retry
              </Text>
            </PressableScale>
          ) : null}

          {message.command?.raw ? (
            <View style={styles.rawSection}>
              <PressableScale
                onPress={() => setRawOpen((open) => !open)}
                accessibilityRole="button"
                accessibilityLabel={rawOpen ? 'Hide raw' : 'Raw'}
                accessibilityState={{ expanded: rawOpen }}
                hitSlop={CHIP_HIT_SLOP}
                style={styles.rawButton}>
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
                      borderColor: tokens.border,
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
                  hitSlop={CHIP_HIT_SLOP}
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
                  hitSlop={CHIP_HIT_SLOP}
                  style={styles.actionButton}>
                  <Text variant="caption" color="accent">
                    Cancel
                  </Text>
                </PressableScale>
              ) : null}
            </View>
          ) : null}

          {message.streaming || commandStatus === 'running' ? <StreamingIndicator /> : null}
          </View>
        </PressableScale>
      </View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  attachments: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.one,
    marginBottom: Spacing.one,
  },
  attachmentImage: {
    width: 140,
    height: 140,
    borderRadius: Radius.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    alignSelf: 'stretch',
    width: '100%',
    gap: Spacing.two,
  },
  rowUser: {
    justifyContent: 'flex-end',
  },
  rowAssistant: {
    justifyContent: 'flex-start',
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
    alignItems: 'stretch',
    flexGrow: 1,
  },
  bubble: {
    gap: Spacing.two,
    maxWidth: '100%',
  },
  userBubble: {
    borderRadius: Radius.xl,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  assistantBubble: {
    padding: 0,
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
  activitySection: {
    gap: Spacing.two,
  },
  activityToggle: {
    alignSelf: 'flex-start',
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  activityCard: {
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.two,
    gap: Spacing.two,
    maxHeight: 320,
  },
  reasoningScroll: {
    maxHeight: 200,
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
  interruptedReason: {
    fontSize: 12,
    lineHeight: 16,
    paddingHorizontal: Spacing.one,
  },
});
