import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { StreamingIndicator } from '@/components/chat/streaming-indicator';
import { Card, PressableScale, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { entering } from '@/lib/motion/presets';
import { useTokens } from '@/hooks/use-tokens';
import type { ChatMessage, CommandTranscriptEntry } from '@/lib/gateway/types';

type MessageBubbleProps = {
  message: ChatMessage;
  onRetry?: (entry: Partial<CommandTranscriptEntry> & { input: string }) => void;
  onCancel?: (id: string) => void;
};

export function MessageBubble({ message, onRetry, onCancel }: MessageBubbleProps) {
  const tokens = useTokens();
  const isUser = message.role === 'user';
  const isCommand = !!message.command;
  const [rawOpen, setRawOpen] = useState(false);
  const commandStatus = message.command?.status;
  const statusColor =
    commandStatus === 'error'
      ? tokens.statusDisconnected
      : commandStatus === 'running'
        ? tokens.statusConnecting
        : tokens.statusConnected;

  const duration = message.command?.durationMs
    ? `${Math.round(message.command.durationMs / 1000)}s`
    : undefined;

  return (
    <Animated.View
      entering={isUser ? entering.slideInRight : entering.slideInLeft}
      style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      <Card
        variant={isUser ? 'chip' : 'surface'}
        padding={Spacing.three}
        style={[
          styles.bubble,
          isCommand && styles.commandBubble,
          isUser
            ? { backgroundColor: tokens.accentMuted, borderColor: tokens.accentWarm }
            : message.streaming || commandStatus === 'running'
              ? { borderColor: tokens.accentWarmMuted }
              : commandStatus === 'error'
                ? { borderColor: tokens.statusDisconnected }
              : { borderColor: tokens.glassBorder },
        ]}>
        {isCommand ? (
          <View style={styles.commandHeader}>
            <View style={styles.commandTitle}>
              <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
              <Text variant="caption" color="secondary" numberOfLines={1}>
                {message.command?.title ?? 'Command'}
              </Text>
            </View>
            {message.command?.ephemeral ? (
              <Text variant="caption" color="tertiary">
                Local
              </Text>
            ) : null}
          </View>
        ) : null}

        <Text color="primary" variant={isCommand ? 'caption' : 'body'}>
          {message.text}
        </Text>

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

        {/* Command actions: duration, retry, raw already handled */}
        {isCommand && (
          <View style={styles.commandActions}>
            {duration ? (
              <Text variant="caption" color="tertiary">
                {duration}
              </Text>
            ) : null}
            {commandStatus === 'error' && onRetry && message.command?.input && (
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
            )}
            {commandStatus === 'running' && onCancel && (
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
            )}
          </View>
        )}

        {message.streaming || commandStatus === 'running' ? <StreamingIndicator /> : null}
      </Card>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
  },
  rowUser: {
    justifyContent: 'flex-end',
  },
  rowAssistant: {
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '85%',
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  commandBubble: {
    maxWidth: '92%',
    gap: Spacing.one,
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
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
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
    marginTop: Spacing.one,
  },
  actionButton: {
    paddingHorizontal: Spacing.one,
    paddingVertical: 2,
  },
});
