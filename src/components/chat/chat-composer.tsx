import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { Badge, Card, Icon, PressableScale, Text } from '@/components/ui';
import { FontFamily, Radius, Spacing } from '@/constants/tokens';
import type { SlashCommandSuggestion } from '@/lib/gateway/slash-commands';
import { springSnappy } from '@/lib/motion/presets';
import { useTokens } from '@/hooks/use-tokens';

type ChatComposerProps = {
  draft: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  onStop: () => void;
  onRefresh: () => void;
  onReconnect: () => void;
  slashSuggestions?: SlashCommandSuggestion[];
  onSelectSlashSuggestion?: (value: string) => void;
  isStreaming: boolean;
  canSend: boolean;
};

export function ChatComposer({
  draft,
  onChangeText,
  onSend,
  onStop,
  onRefresh,
  onReconnect,
  slashSuggestions = [],
  onSelectSlashSuggestion,
  isStreaming,
  canSend,
}: ChatComposerProps) {
  const tokens = useTokens();
  const [focused, setFocused] = useState(false);
  const sendWidth = useSharedValue(56);

  const sendAnimatedStyle = useAnimatedStyle(() => ({
    minWidth: sendWidth.value,
  }));

  const handleAction = async () => {
    if (isStreaming) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      onStop();
      return;
    }
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSend();
  };

  const isActionDisabled = !canSend || (!isStreaming && !draft.trim());
  // Input stays editable whenever the user can queue or send (including offline).
  const inputEditable = canSend && !isStreaming;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={72}>
      <View style={styles.dock}>
        <View style={styles.utilityRow}>
          <View style={styles.chipGroup} />
          <View style={styles.chipGroup}>
            <PressableScale
              onPress={async () => {
                await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onRefresh();
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Reload history"
              style={styles.utilityButton}>
              <Icon name={{ ios: 'arrow.clockwise', android: 'refresh', web: 'refresh' }} size={15} color="textTertiary" />
            </PressableScale>
            <PressableScale
              onPress={async () => {
                await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onReconnect();
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Reconnect gateway"
              style={styles.utilityButton}>
              <Icon name={{ ios: 'bolt.horizontal', android: 'cable', web: 'cable' }} size={15} color="textTertiary" />
            </PressableScale>
          </View>
        </View>

        {slashSuggestions.length > 0 ? (
          <View
            style={[
              styles.palette,
              { backgroundColor: tokens.backgroundRaised, borderColor: tokens.glassBorder },
            ]}>
            <Text variant="micro" color="tertiary" style={styles.paletteTitle}>
              Commands
            </Text>
            <ScrollView
              style={styles.paletteScroll}
              contentContainerStyle={styles.paletteContent}
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}>
              {slashSuggestions.map((item) => {
                const unavailable = item.unavailable;
                const danger = item.danger === 'write' || item.danger === 'destructive';
                return (
                  <PressableScale
                    key={item.value}
                    style={[
                      styles.paletteItem,
                      {
                        backgroundColor: tokens.backgroundInset,
                        borderColor: danger ? tokens.accentWarmMuted : tokens.borderSubtle,
                        opacity: unavailable ? 0.55 : 1,
                      },
                    ]}
                    disabled={unavailable}
                    accessibilityRole="button"
                    accessibilityLabel={`Command ${item.label}`}
                    onPress={async () => {
                      if (!unavailable) {
                        await Haptics.selectionAsync();
                        onSelectSlashSuggestion?.(item.value);
                      }
                    }}>
                    <View style={styles.paletteRow}>
                      <Text variant="caption" numberOfLines={1} style={styles.paletteLabel}>
                        {item.label}
                      </Text>
                      {item.danger === 'destructive' ? (
                        <Icon
                          name={{ ios: 'exclamationmark.triangle.fill', android: 'warning', web: 'warning' }}
                          size={11}
                          color="statusDisconnected"
                        />
                      ) : item.danger === 'write' ? (
                        <Icon
                          name={{ ios: 'exclamationmark.triangle', android: 'warning', web: 'warning' }}
                          size={11}
                          color="statusConnecting"
                        />
                      ) : null}
                      {item.family ? <Badge label={item.family} dot={false} /> : null}
                    </View>
                    <Text variant="micro" color="tertiary" numberOfLines={1} style={styles.paletteDesc}>
                      {item.description}
                      {unavailable ? ' (unavailable)' : ''}
                    </Text>
                  </PressableScale>
                );
              })}
            </ScrollView>
          </View>
        ) : null}

        <Card
          padding={Spacing.two}
          style={[
            styles.composer,
            { borderColor: focused ? tokens.borderStrong : tokens.glassBorder },
          ]}>
          <TextInput
            style={[styles.input, { color: tokens.textPrimary }]}
            value={draft}
            onChangeText={onChangeText}
            placeholder={canSend ? 'Message or /command' : 'Connect a gateway to chat'}
            placeholderTextColor={tokens.textTertiary}
            multiline
            editable={inputEditable}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            accessibilityLabel="Message input"
          />
          <Animated.View style={sendAnimatedStyle}>
            <PressableScale
              style={[
                styles.sendButton,
                {
                  backgroundColor: isStreaming ? tokens.accentWarm : tokens.accent,
                  borderColor: tokens.accentWarm,
                },
                isActionDisabled && styles.sendDisabled,
              ]}
              onPress={() => void handleAction()}
              disabled={isActionDisabled}
              accessibilityRole="button"
              accessibilityLabel={isStreaming ? 'Stop streaming' : 'Send message'}
              onPressIn={() => {
                // Reanimated shared value — mutable by design, not React state.
                // eslint-disable-next-line react-hooks/immutability
                sendWidth.value = withSpring(isStreaming ? 68 : 52, springSnappy);
              }}
              onPressOut={() => {
                // Reanimated shared value — mutable by design, not React state.
                // eslint-disable-next-line react-hooks/immutability
                sendWidth.value = withSpring(56, springSnappy);
              }}>
              <Icon
                name={
                  isStreaming
                    ? { ios: 'stop.fill', android: 'stop', web: 'stop' }
                    : { ios: 'arrow.up', android: 'arrow_upward', web: 'arrow_upward' }
                }
                size={16}
                color="textInverse"
              />
            </PressableScale>
          </Animated.View>
        </Card>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  dock: {
    paddingBottom: Spacing.two,
    gap: Spacing.two,
  },
  utilityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.four,
    minHeight: 24,
  },
  chipGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  contextChip: {
    maxWidth: 132,
  },
  utilityButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  palette: {
    marginHorizontal: Spacing.four,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    maxHeight: 180,
  },
  paletteTitle: {
    paddingHorizontal: Spacing.three - 4,
    paddingTop: Spacing.two,
    textTransform: 'uppercase',
  },
  paletteScroll: {
    maxHeight: 150,
  },
  paletteContent: {
    padding: Spacing.one,
    gap: Spacing.one,
  },
  paletteItem: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one + 2,
    gap: 2,
  },
  paletteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  paletteLabel: {
    flex: 1,
    fontFamily: FontFamily.sansSemiBold,
  },
  paletteDesc: {
    paddingRight: Spacing.two,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.two,
    marginHorizontal: Spacing.four,
    borderRadius: Radius.xl,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 140,
    fontSize: 16,
    fontFamily: FontFamily.sans,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  sendButton: {
    borderRadius: Radius.md,
    minHeight: 40,
    paddingHorizontal: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  sendDisabled: {
    opacity: 0.5,
  },
});
