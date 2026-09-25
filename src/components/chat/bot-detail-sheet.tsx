import * as Clipboard from 'expo-clipboard';
import { ScrollView, StyleSheet, View } from 'react-native';

import { BotApprovalPolicyRow } from '@/components/chat/bot-approval-policy';
import { BotMemoryPane } from '@/components/chat/bot-memory-pane';
import { BaseSheet, Button, Divider, ListRow, PressableScale, Skeleton, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { haptics } from '@/lib/haptics';
import { describeBotDetail } from '@/lib/gateway/bot-detail';
import { botSoulCopy, EMPTY_BOT_SOUL, type BotSoulState, type PublicBot } from '@/lib/gateway/bots';

export type BotDetailSheetProps = {
  /** The Bot to describe; null renders nothing (sheet dismissed). */
  bot: PublicBot | null;
  /**
   * This Bot's standing instructions, read on demand by the parent. Absent on
   * a Gate that cannot serve `bots.get`, which renders as an honest "could not
   * be read" rather than as "this Bot has none".
   */
  soul?: BotSoulState;
  onClose: () => void;
  /**
   * Opens this Bot's chat — the parent owns that navigation (same path a
   * roster tap takes). Hidden for Bots the routing verdict refuses, so the
   * row never invites a guaranteed send failure.
   */
  onMessage?: () => void;
  /**
   * Opens the edit form prefilled with this Bot — the parent owns that sheet.
   * The row hides itself for the default profile, which the Gate refuses to
   * edit (ADR 0011).
   */
  onEdit?: () => void;
  /**
   * Re-run the same `bots.get` read the detail effect runs. Rendered only
   * on the failed-first-read soul path, so no button without a handler
   * and none over a loaded soul.
   */
  onRetry?: () => void;
  /**
   * Export this Bot as a handoff packet and open the share sheet (D6). The
   * parent supplies it only where a share sheet exists, so no button is drawn
   * that cannot finish. A packet never carries memory or credentials.
   */
  onExport?: () => void;
  /**
   * The parent's line for the last refused export, or nothing after a
   * successful share / a dismissal. Rendered under the Export row so a tap
   * that opened no sheet says so instead of vanishing.
   */
  exportNotice?: string;
  /** Clears `exportNotice` — the parent owns that state. */
  onDismissExportNotice?: () => void;
};

/**
 * The roster row's detail surface: description, model pin, routing state
 * with its fix, and the profile id. Everything here was already on the
 * roster payload — long-press a row to read what one line cannot carry,
 * then act: message the agent, copy the id for host-side commands, or edit
 * what the Gate holds.
 */
export function BotDetailSheet({
  bot,
  soul,
  onClose,
  onMessage,
  onEdit,
  onRetry,
  onExport,
  exportNotice,
  onDismissExportNotice,
}: BotDetailSheetProps) {
  if (!bot) return null;
  const detail = describeBotDetail(bot);
  const soulState = soul ?? EMPTY_BOT_SOUL;
  const soulNote = botSoulCopy(soulState);

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
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}>
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
            SOUL
          </Text>
          {soulState.soul ? (
            <Text variant="body" color="secondary">
              {soulState.soul.trim()}
            </Text>
          ) : null}
          {soulNote ? (
            <Text variant="caption" color={soulState.failed ? 'statusDisconnected' : 'tertiary'}>
              {soulNote}
            </Text>
          ) : null}
          {!soulState.loaded && !soulState.failed ? (
            <Skeleton width="90%" height={44} />
          ) : null}
          {!soulState.loaded && soulState.failed && onRetry ? (
            <Button label="Retry" variant="ghost" size="sm" onPress={onRetry} />
          ) : null}
        </View>

        {/* D1: the per-Bot auto-approve opt-in (read-only classes only). */}
        <BotApprovalPolicyRow botId={bot.id} />

        {/* P2: the Bot's memory, read on demand from the Gate host. */}
        <BotMemoryPane botId={bot.id} />

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
          <Text variant="body" color={detail.routingNext ? 'accent' : undefined}>
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

        {onMessage && detail.messagable ? (
          <ListRow
            title={`Message ${detail.name}`}
            subtitle="Open this agent's chat"
            icon={{ ios: 'bubble.left.and.bubble.right', android: 'chat', web: 'chat' }}
            chevron={false}
            onPress={onMessage}
          />
        ) : null}
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
        {onExport ? (
          <ListRow
            title="Export handoff"
            subtitle="Soul, routines and skills — never memory or credentials"
            icon={{ ios: 'square.and.arrow.up', android: 'share', web: 'share' }}
            chevron={false}
            onPress={onExport}
          />
        ) : null}
        {onExport && exportNotice ? (
          <PressableScale
            onPress={onDismissExportNotice}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Dismiss export notice"
            style={styles.exportNotice}>
            <Text variant="caption" color="accent">
              {exportNotice}
            </Text>
          </PressableScale>
        ) : null}
      </View>
      </ScrollView>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  scroll: {
    gap: Spacing.two,
    paddingBottom: Spacing.two,
  },
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
  exportNotice: {
    paddingHorizontal: Spacing.one,
  },
});
