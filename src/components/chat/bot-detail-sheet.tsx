import { StyleSheet, View } from 'react-native';

import { BaseSheet, Divider, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { describeBotDetail } from '@/lib/gateway/bot-detail';
import type { PublicBot } from '@/lib/gateway/bots';

export type BotDetailSheetProps = {
  /** The Bot to describe; null renders nothing (sheet dismissed). */
  bot: PublicBot | null;
  onClose: () => void;
};

/**
 * The roster row's detail surface: description, model pin, routing state
 * with its fix, and the profile id. Everything here was already on the
 * roster payload — long-press a row to read what one line cannot carry.
 */
export function BotDetailSheet({ bot, onClose }: BotDetailSheetProps) {
  if (!bot) return null;
  const detail = describeBotDetail(bot);

  return (
    <BaseSheet
      visible
      eyebrow="AGENT"
      title={detail.name}
      onClose={onClose}
      closeLabel="Dismiss">
      {detail.description ? (
        <Text variant="body" color="secondary" style={styles.description}>
          {detail.description}
        </Text>
      ) : (
        <Text variant="caption" color="tertiary" style={styles.description}>
          No description yet.
        </Text>
      )}

      <View style={styles.facts}>
        <View style={styles.fact}>
          <Text variant="micro" color="tertiary">
            MODEL PIN
          </Text>
          {detail.modelPin ? (
            <Text variant="body">{detail.modelPin}</Text>
          ) : (
            <Text variant="body" color="secondary">
              Unpinned — uses the gateway default
            </Text>
          )}
        </View>

        <View style={styles.fact}>
          <Text variant="micro" color="tertiary">
            ROUTING
          </Text>
          <Text variant="body" color={detail.routingNext ? 'accentWarm' : undefined}>
            {detail.routingTitle}
          </Text>
          {detail.routingNext ? (
            <Text variant="caption" color="secondary">
              {detail.routingNext}
            </Text>
          ) : null}
        </View>

        <Divider />
        <View style={styles.fact}>
          <Text variant="micro" color="tertiary">
            PROFILE ID
          </Text>
          <Text variant="mono">{detail.id}</Text>
        </View>
      </View>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  description: {
    paddingHorizontal: Spacing.one,
    paddingBottom: Spacing.two,
  },
  facts: {
    gap: Spacing.two,
    paddingHorizontal: Spacing.one,
  },
  fact: {
    gap: 2,
  },
});
