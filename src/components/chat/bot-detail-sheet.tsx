import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { BotApprovalPolicyRow } from '@/components/chat/bot-approval-policy';
import { BotMemoryPane } from '@/components/chat/bot-memory-pane';
import { BaseSheet, Button, Divider, Icon, ListRow, PressableScale, Skeleton, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { haptics } from '@/lib/haptics';
import { describeBotDetail } from '@/lib/gateway/bot-detail';
import {
  botProfileFeatures,
  botRuntimeWritable,
  botSoulCopy,
  EMPTY_BOT_SOUL,
  type BotSoulState,
  type PublicBot,
} from '@/lib/gateway/bots';

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
  /** Opens the Look studio for this Bot — its form, face and colour, kept on this device. */
  onChangeLook?: () => void;
};

/** A soul longer than this can push the sheet's actions off a short phone. */
const SOUL_COLLAPSE_CHARS = 280;
const SOUL_COLLAPSE_LINES = 4;
/** The collapsed soul keeps this many lines, enough to recognise the Bot. */
const SOUL_PREVIEW_LINES = 3;

/**
 * Whether a soul should open as a preview rather than in full. Both lengths
 * count: prose wraps past the character budget, and a stack of short lines is
 * just as tall. The sheet is how an operator reaches the auto-approve row,
 * memory, model pin and actions, so a long soul must not bury them.
 */
function soulNeedsCollapse(soul: string): boolean {
  return soul.length > SOUL_COLLAPSE_CHARS || soul.split('\n').length > SOUL_COLLAPSE_LINES;
}

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
  onChangeLook,
}: BotDetailSheetProps) {
  const [held, setHeld] = useState(bot);
  // The soul's disclosure is per sheet-open: opening resets it to the default
  // (a long soul starts as a preview), a different Bot shown in the same sheet
  // resets it again, and nothing survives a dismissal. The closing render keeps
  // its shape so the sheet does not visibly snap while it animates away.
  const [soulDisclosure, setSoulDisclosure] = useState<{
    botId: string | null;
    open: boolean;
    expanded: boolean;
  }>({ botId: null, open: false, expanded: false });
  if (bot && bot !== held) setHeld(bot);
  const sheetOpen = bot !== null;
  if (sheetOpen !== soulDisclosure.open) {
    setSoulDisclosure(
      sheetOpen
        ? { botId: bot?.id ?? null, open: true, expanded: false }
        : { ...soulDisclosure, open: false },
    );
  } else if (sheetOpen && soulDisclosure.botId !== (bot?.id ?? null)) {
    setSoulDisclosure({ botId: bot?.id ?? null, open: true, expanded: false });
  }
  if (!held) return null;
  const shown = bot ?? held;
  const detail = describeBotDetail(shown);
  // Memory files are a Hermes profile's own tree (ADR 0016). An OpenCode,
  // Claude Code or Codex Bot has none, so the pane is not drawn at all — a
  // panel that only ever answers "could not be read" is a refusal with extra
  // steps.
  const features = botProfileFeatures(shown.runtime);
  const writable = botRuntimeWritable(shown.runtime);
  const soulState = soul ?? EMPTY_BOT_SOUL;
  const soulNote = botSoulCopy(soulState);
  const soulText = soulState.soul?.trim() ?? '';
  const soulIsLong = soulNeedsCollapse(soulText);
  const soulCollapsed = soulIsLong && !soulDisclosure.expanded;
  const soulExpanded = soulIsLong && soulDisclosure.expanded;

  const toggleSoul = () => {
    setSoulDisclosure((current) => ({ ...current, expanded: !current.expanded }));
  };

  const handleCopyId = async () => {
    try {
      await Clipboard.setStringAsync(detail.id);
      await haptics.success();
    } catch {
      // Clipboard refused: the tap still happened; nothing to copy.
    }
  };

  return (
    <BaseSheet
      visible={!!bot}
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
            {/* The same chevron/haptic disclosure DisclosureRow draws for a
                section, kept as a micro fact head: SOUL sits among this
                sheet's fact labels, not in a stack of section cards. */}
            {soulIsLong ? (
              <PressableScale
                onPress={async () => {
                  await haptics.selection();
                  toggleSoul();
                }}
                accessibilityRole="button"
                accessibilityLabel={soulExpanded ? 'Soul, shown in full' : 'Soul, preview shown'}
                accessibilityState={{ expanded: soulExpanded }}
                hitSlop={8}
                style={styles.soulHeader}>
                <Text variant="micro" color="tertiary">
                  SOUL
                </Text>
                <Icon
                  name={
                    soulExpanded
                      ? { ios: 'chevron.up', android: 'expand_less', web: 'expand_less' }
                      : { ios: 'chevron.down', android: 'expand_more', web: 'expand_more' }
                  }
                  size={16}
                  color="textTertiary"
                />
              </PressableScale>
            ) : (
              <Text variant="micro" color="tertiary">
                SOUL
              </Text>
            )}
            {soulState.soul ? (
              <>
                <Text
                  variant="body"
                  color="secondary"
                  numberOfLines={soulCollapsed ? SOUL_PREVIEW_LINES : undefined}>
                  {soulText}
                </Text>
                {soulCollapsed ? (
                  <PressableScale
                    onPress={async () => {
                      await haptics.selection();
                      toggleSoul();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Show the whole soul"
                    hitSlop={8}
                    style={styles.soulShowAll}>
                    <Text variant="caption" color="accent">
                      Show all
                    </Text>
                  </PressableScale>
                ) : null}
              </>
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
        <BotApprovalPolicyRow botId={shown.id} />

        {/* P2: the Bot's memory, read on demand from the Gate host. */}
        {features.memory ? <BotMemoryPane botId={shown.id} /> : null}

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
        {onChangeLook ? (
          <ListRow
            title="Change look"
            subtitle="Form, face and colour"
            icon={{ ios: 'paintpalette', android: 'palette', web: 'palette' }}
            chevron={false}
            onPress={onChangeLook}
          />
        ) : null}
        <ListRow
          title="Copy profile id"
          subtitle="For host-side hermes -p commands"
          icon={{ ios: 'doc.on.doc', android: 'content_copy', web: 'content_copy' }}
          chevron={false}
          onPress={() => void handleCopyId()}
        />
        {onEdit && detail.editable && writable ? (
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
  soulHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: Spacing.one,
    minHeight: 24,
  },
  soulShowAll: {
    alignSelf: 'flex-start',
    justifyContent: 'center',
    minHeight: 24,
  },
  exportNotice: {
    paddingHorizontal: Spacing.one,
  },
});
