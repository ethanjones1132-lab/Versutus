import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { BotAvatar } from '@/components/chat/bot-avatar';
import { BaseSheet, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { PublicBot } from '@/lib/gateway/bots';

/**
 * The Bot's own panel, opened from its name in the thread header: who the
 * Bot is (crest, name, purpose, pinned model), then its voice and its panes.
 * It replaces the inline "Bot" strip that used to sit between the header and
 * the transcript, so a Bot Chat opens on the conversation.
 */
export function BotPanelSheet({
  visible,
  onClose,
  botId,
  bot,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  /** Always known on a Bot surface, even before the roster read lands. */
  botId: string;
  /** The roster's record for the Bot, when it has been read. */
  bot?: PublicBot;
  children: ReactNode;
}) {
  const tokens = useTokens();
  const name = bot?.displayName ?? botId;
  const model = bot?.model?.default ?? null;

  return (
    <BaseSheet visible={visible} onClose={onClose} eyebrow="Bot">
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        <View style={styles.hero}>
          <BotAvatar botId={botId} name={name} size={72} />
          <Text variant="title" style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          {bot?.description ? (
            <Text color="secondary" style={styles.description}>
              {bot.description}
            </Text>
          ) : null}
          {model ? (
            <View style={[styles.modelPill, { backgroundColor: tokens.backgroundInset }]}>
              <Text variant="caption" color="secondary" numberOfLines={1}>
                {model}
              </Text>
            </View>
          ) : null}
        </View>
        {children}
      </ScrollView>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flexGrow: 0,
  },
  content: {
    paddingBottom: Spacing.three,
    gap: Spacing.four,
  },
  hero: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingTop: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  name: {
    marginTop: Spacing.one,
    textAlign: 'center',
  },
  description: {
    textAlign: 'center',
    maxWidth: 320,
  },
  modelPill: {
    marginTop: Spacing.one,
    paddingHorizontal: Spacing.three - 4,
    paddingVertical: Spacing.one + 1,
    borderRadius: Radius.full,
  },
});
