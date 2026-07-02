import * as Haptics from 'expo-haptics';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { Card, PressableScale, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
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

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={72}>
      <View style={styles.dock}>
        <View style={styles.actions}>
          <PressableScale onPress={async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onRefresh();
          }}>
            <Text variant="caption" color="secondary" style={styles.utilityAction}>
              Refresh
            </Text>
          </PressableScale>
          <PressableScale onPress={async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onReconnect();
          }}>
            <Text variant="caption" color="secondary" style={styles.utilityAction}>
              Reconnect gateway
            </Text>
          </PressableScale>
        </View>

        {slashSuggestions.length > 0 ? (
          <View style={styles.palette}>
            <Text variant="caption" color="secondary" style={styles.paletteTitle}>
              Commands
            </Text>
            <ScrollView
              style={styles.paletteScroll}
              contentContainerStyle={styles.paletteContent}
              nestedScrollEnabled
              showsVerticalScrollIndicator={false}
            >
              {slashSuggestions.map((item) => {
                const unavailable = item.unavailable;
                const bg = unavailable
                  ? tokens.backgroundInset
                  : item.danger === 'write' || item.danger === 'destructive'
                    ? tokens.accentWarmMuted
                    : tokens.backgroundInset;
                return (
                  <PressableScale
                    key={item.value}
                    style={[
                      styles.paletteItem,
                      {
                        backgroundColor: bg,
                        borderColor: tokens.glassBorder,
                        opacity: unavailable ? 0.6 : 1,
                      },
                    ]}
                    disabled={unavailable}
                    onPress={async () => {
                      if (!unavailable) {
                        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        onSelectSlashSuggestion?.(item.value);
                      }
                    }}>
                    <View style={styles.paletteRow}>
                      <Text variant="caption" numberOfLines={1} style={{ flex: 1 }}>
                        {item.label}
                      </Text>
                      {item.family && (
                        <Text variant="caption" color="tertiary" style={styles.familyBadge}>
                          {item.family}
                        </Text>
                      )}
                      {item.danger && item.danger !== 'safe' && (
                        <Text variant="caption" style={{ color: tokens.accentWarm, fontSize: 9 }}>
                          {item.danger === 'destructive' ? '!' : '⚠'}
                        </Text>
                      )}
                    </View>
                    <Text variant="caption" color="tertiary" numberOfLines={1} style={styles.paletteDesc}>
                      {item.description}
                      {unavailable ? ' (unavailable)' : ''}
                    </Text>
                  </PressableScale>
                );
              })}
            </ScrollView>
          </View>
        ) : null}

        <Card padding={Spacing.two} style={styles.composer}>
          <TextInput
            style={[styles.input, { color: tokens.textPrimary }]}
            value={draft}
            onChangeText={onChangeText}
            placeholder="Message or /command"
            placeholderTextColor={tokens.textTertiary}
            multiline
            editable={canSend && !isStreaming}
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
              onPressIn={() => {
                sendWidth.value = withSpring(isStreaming ? 68 : 52, springSnappy);
              }}
              onPressOut={() => {
                sendWidth.value = withSpring(56, springSnappy);
              }}>
              <Text variant="caption" color="inverse">
                {isStreaming ? 'Stop' : 'Send'}
              </Text>
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
    gap: Spacing.one,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.four,
  },
  utilityAction: {
    textTransform: 'uppercase',
  },
  palette: {
    marginHorizontal: Spacing.four,
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(240, 214, 144, 0.15)',
    maxHeight: 160,
  },
  paletteTitle: {
    paddingHorizontal: Spacing.two,
    paddingTop: Spacing.one,
    textTransform: 'uppercase',
  },
  paletteScroll: {
    maxHeight: 130,
  },
  paletteContent: {
    padding: Spacing.one,
    gap: Spacing.one,
  },
  paletteItem: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  paletteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  familyBadge: {
    fontSize: 9,
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 4,
    borderRadius: 3,
  },
  paletteDesc: {
    fontSize: 11,
    lineHeight: 13,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.two,
    marginHorizontal: Spacing.four,
    borderRadius: Radius.xl,
    borderColor: 'rgba(240, 214, 144, 0.22)',
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 140,
    fontSize: 16,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  sendButton: {
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  sendDisabled: {
    opacity: 0.5,
  },
});
