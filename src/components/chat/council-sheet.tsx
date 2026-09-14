import { ScrollView, StyleSheet, View } from 'react-native';

import { BaseSheet, Button, Chip, EmptyState, Text, TextField } from '@/components/ui';
import { BotAvatar } from '@/components/chat/bot-avatar';
import { Radius, Spacing } from '@/constants/tokens';
import type { PublicBot } from '@/lib/gateway/bots';
import {
  COUNCIL_DESTINATION_COPY,
  COUNCIL_MIN_BOTS,
  botResultLine,
  councilPromptCopy,
} from '@/lib/gateway/council-view';

/**
 * D7 council sheet (FUTURE-ITEMS.md §D7, slice 1): one prompt to several
 * Bots, answers side by side. Every word is the folds' (`council-view.ts`,
 * `council.ts`) — the send gates on the same floor the send copy counts,
 * the columns render the roster's rows, and an unfilled slot owes a reply
 * rather than fabricating one. There is no live capture in this sheet: the
 * legs ride the per-Bot send path to each Bot's own Bot Chat (ADR 0012),
 * and an unfilled column says so.
 */

export type CouncilColumn = {
  bot: PublicBot;
  /** The slot's own line — an answer, a failed leg's cause, or the wait. */
  line: string;
};

export function CouncilSheet({
  visible,
  bots,
  pickedIds,
  onToggleBot,
  prompt,
  onPromptChange,
  busy,
  progressLine,
  columns,
  onSend,
  onClose,
}: {
  visible: boolean;
  /** The askable roster: routable Bots the gateway inventories. */
  bots: readonly PublicBot[];
  /** Bot ids the operator has picked, in pick order. */
  pickedIds: readonly string[];
  /** Toggle one Bot's pick — the sheet draws the state, the screen owns it. */
  onToggleBot: (botId: string) => void;
  prompt: string;
  onPromptChange: (text: string) => void;
  /** True from when the fan-out starts until every leg settled or failed. */
  busy: boolean;
  /** The live progress fold's line, or undefined while idle. */
  progressLine?: string;
  /** The comparison columns' current lines, keyed by Bot id — empty while idle. */
  columns?: readonly CouncilColumn[];
  onSend: () => void;
  onClose: () => void;
}) {
  if (!visible) return null;

  const picked = bots.filter((bot) => pickedIds.includes(bot.id));
  const send = { pickedCount: pickedIds.length, hasPrompt: prompt.trim().length > 0, busy };

  return (
    <BaseSheet
      visible={visible}
      eyebrow="COUNCIL"
      title="Council"
      onClose={onClose}
      closeLabel="Close"
      position="bottom">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}>
        <Text variant="caption" color="secondary">
          {councilPromptCopy()}
        </Text>

        {bots.length === 0 ? (
          <EmptyState
            icon={{ ios: 'person.3', android: 'groups', web: 'groups' }}
            title="No Bots on this gateway"
            description="Named Hermes profiles appear here once the Gate can inventory them."
          />
        ) : null}

        <View style={styles.pickRow}>
          {bots.map((bot) => (
            <Chip
              key={bot.id}
              label={bot.displayName}
              selected={pickedIds.includes(bot.id)}
              onPress={() => onToggleBot(bot.id)}
              disabled={busy}
            />
          ))}
        </View>

        <TextField
          value={prompt}
          onChangeText={onPromptChange}
          placeholder="Ask the council…"
          multiline
          editable={!busy}
          style={styles.prompt}
        />

        {progressLine ? (
          <Text variant="caption" color="secondary">
            {progressLine}
          </Text>
        ) : null}

        {columns && columns.length > 0 ? (
          <View style={styles.columns}>
            {columns.map((column) => (
              <View key={column.bot.id} style={styles.column}>
                <View style={styles.columnHead}>
                  <BotAvatar botId={column.bot.id} />
                  <Text variant="caption" numberOfLines={1}>
                    {column.bot.displayName}
                  </Text>
                </View>
                <Text variant="caption" color="secondary" selectable>
                  {column.line}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        <Text variant="micro" color="tertiary">
          {COUNCIL_DESTINATION_COPY}
        </Text>

        <Button
          label="Send to council"
          onPress={onSend}
          disabled={busy || pickedIds.length < COUNCIL_MIN_BOTS || !prompt.trim()}
          expanded
          accessibilityHint="Sends one prompt to every picked Bot."
        />
      </ScrollView>
    </BaseSheet>
  );
}

const styles = StyleSheet.create({
  scroll: { gap: Spacing.two, paddingBottom: Spacing.two },
  pickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  prompt: { minHeight: 72 },
  columns: { gap: Spacing.two },
  column: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.md,
    padding: Spacing.two,
    gap: Spacing.one,
  },
  columnHead: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
});
