import * as Clipboard from 'expo-clipboard';
import { StyleSheet, View } from 'react-native';

import { BaseSheet, Divider, ListRow, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { haptics } from '@/lib/haptics';
import { describeBotDetail } from '@/lib/gateway/bot-detail';
import type { PublicBot } from '@/lib/gateway/bots';

export type BotDetailSheetProps = {
  /** The Bot to describe; null renders nothing (sheet dismissed). */
  bot: PublicBot | null;
  onClose: () => void;
  /**
   * Opens the edit form prefilled with this Bot — the parent owns that sheet.
   * The row hides itself for the default profile, which the Gate refuses to
   * edit (ADR 0011).
   */
  onEdit?: () => void;
};

/**
 * The roster row's detail surface: description, model pin, routing state
 * with its fix, and the profile id. Everything here was already on the
 * roster payload — long-press a row to read what one line cannot carry,
 * then act: copy the id for host-side commands, or edit what the Gate holds.
 */
export function BotDetailSheet({ bot, onClose, onEdit }: BotDetailSheetProps) {
  if (!bot) return null;
  const detail = describeBotDetail(bot);

  const handleCopyId = async () => {
    await Clipboard.setStringAsync(detail.id);
    await haptics.success();
  };

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

        <ListRow
          title="Copy profile id"
          subtitle="For host-side hermes -p commands"
          icon={{ ios: 'doc.on.doc', android: 'content_copy', web: 'content_copy' }}
          chevron={false}
          onPress={() => void handleCopyId()}
        />
        {onEdit && detail.editable ? (
          <ListRow
            title="Edit agent"
            subtitle="Description, soul, and model pin"
            icon={{ ios: 'pencil', android: 'edit', web: 'edit' }}
            chevron={false}
            onPress={onEdit}
          />
        ) : null}
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
