import { Button as ComposeButton, Host, Text as ComposeText, TextButton } from '@expo/ui/jetpack-compose';
import * as Haptics from 'expo-haptics';
import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from 'react-native';

import { Card, Text, TextField } from '@/components/ui';
import { FontFamily, Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { SlashCommandSuggestion } from '@/lib/gateway/slash-commands';

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
    <KeyboardAvoidingView behavior={undefined} keyboardVerticalOffset={0}>
      <View style={styles.dock}>
        <View style={styles.actions}>
          <Host matchContents style={styles.utilityHost}>
            <TextButton
              onClick={async () => {
                await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onRefresh();
              }}>
              <ComposeText color={tokens.textSecondary} style={styles.utilityLabel}>
                Refresh history
              </ComposeText>
            </TextButton>
          </Host>
          <Host matchContents style={styles.utilityHost}>
            <TextButton
              onClick={async () => {
                await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onReconnect();
              }}>
              <ComposeText color={tokens.textSecondary} style={styles.utilityLabel}>
                Reconnect gateway
              </ComposeText>
            </TextButton>
          </Host>
        </View>

        {slashSuggestions.length > 0 ? (
          <View
            style={[
              styles.palette,
              {
                backgroundColor: tokens.backgroundInset,
                borderColor: tokens.glassBorder,
              },
            ]}>
            <Text variant="caption" color="secondary" style={styles.paletteTitle}>
              Commands
            </Text>
            <ScrollView
              style={styles.paletteScroll}
              contentContainerStyle={styles.paletteContent}
              nestedScrollEnabled
              showsVerticalScrollIndicator={false}>
              {slashSuggestions.map((item) => {
                const unavailable = item.unavailable;
                const bg =
                  unavailable
                    ? tokens.backgroundInset
                    : item.danger === 'write' || item.danger === 'destructive'
                      ? tokens.accentWarmMuted
                      : tokens.backgroundElevated;
                return (
                  <Host key={item.value} matchContents style={styles.suggestionHost}>
                    <ComposeButton
                      enabled={!unavailable}
                      onClick={async () => {
                        if (!unavailable) {
                          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                          onSelectSlashSuggestion?.(item.value);
                        }
                      }}
                      colors={{
                        containerColor: bg,
                        contentColor: tokens.textPrimary,
                        disabledContainerColor: tokens.backgroundInset,
                        disabledContentColor: tokens.textTertiary,
                      }}
                      contentPadding={{ start: 12, end: 12, top: 8, bottom: 8 }}>
                      <View style={styles.paletteRow}>
                        <ComposeText color={tokens.textPrimary} style={{ fontSize: 13 }}>
                          {item.label}
                        </ComposeText>
                        {item.family ? (
                          <ComposeText color={tokens.textTertiary} style={{ fontSize: 9 }}>
                            {item.family}
                          </ComposeText>
                        ) : null}
                        {item.danger && item.danger !== 'safe' ? (
                          <ComposeText color={tokens.accentWarm} style={{ fontSize: 9 }}>
                            {item.danger === 'destructive' ? '!' : '⚠'}
                          </ComposeText>
                        ) : null}
                      </View>
                      <ComposeText color={tokens.textTertiary} style={{ fontSize: 11 }}>
                        {item.description}
                        {unavailable ? ' (unavailable)' : ''}
                      </ComposeText>
                    </ComposeButton>
                  </Host>
                );
              })}
            </ScrollView>
          </View>
        ) : null}

        <Card padding={Spacing.two} style={[styles.composer, { borderColor: tokens.accentWarmMuted }]}>
          <TextField
            value={draft}
            onChangeText={onChangeText}
            placeholder="Message or /command"
            multiline
            editable={canSend && !isStreaming}
            style={styles.input}
          />
          <Host matchContents style={styles.sendHost}>
            <ComposeButton
              enabled={!isActionDisabled}
              onClick={() => void handleAction()}
              colors={{
                containerColor: isStreaming ? tokens.accentWarm : tokens.accent,
                contentColor: tokens.textInverse,
                disabledContainerColor: tokens.accentMuted,
                disabledContentColor: tokens.textTertiary,
              }}
              contentPadding={{ start: 16, end: 16, top: 10, bottom: 10 }}>
              <ComposeText
                color={tokens.textInverse}
                style={{
                  fontSize: 13,
                  fontWeight: '600',
                  fontFamily: FontFamily.sansSemiBold,
                }}>
                {isStreaming ? 'Stop' : 'Send'}
              </ComposeText>
            </ComposeButton>
          </Host>
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
  utilityHost: {
    alignSelf: 'flex-start',
  },
  utilityLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  palette: {
    marginHorizontal: Spacing.four,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    maxHeight: 148,
  },
  paletteTitle: {
    paddingHorizontal: Spacing.two,
    paddingTop: Spacing.one,
    textTransform: 'uppercase',
  },
  paletteScroll: {
    maxHeight: 120,
  },
  paletteContent: {
    padding: Spacing.one,
    gap: Spacing.one,
  },
  suggestionHost: {
    alignSelf: 'stretch',
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
  paletteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    flex: 1,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.two,
    marginHorizontal: Spacing.four,
    borderRadius: Radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    minHeight: 40,
  },
  sendHost: {
    alignSelf: 'flex-end',
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
});