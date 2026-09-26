import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Chip, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import {
  BOT_VOICE_RANGE_COPY,
  type BotVoiceOption,
  type BotVoiceRefinementField,
  type BotVoiceRefinementRow,
} from '@/lib/voice/bot-voices';

/**
 * The body of the Bot panel (bot-panel-sheet.tsx): the voice this Bot's
 * replies are read in — with the rate and pitch that voice speaks at — and,
 * under it, the Bot's own panes (skills, tools, routines). The rows are the
 * pure fold's (`src/lib/voice/bot-voices.ts`), so this file authors no order,
 * no step and no copy of its own, and a device the platform named no voice for
 * is handed no options at all: it draws no Voice section rather than a lone
 * row that could not change anything. The refinement rows are the same fold's
 * answer for the voice this Bot is stored with, which is why a Bot on the
 * platform's own default is offered none: there is no entry to write one to.
 *
 * It used to be an inline "Bot" strip above every Bot Chat transcript. The
 * panel now opens from the Bot's name in the header, so the thread starts with
 * the conversation instead of a toggle.
 */
export function BotChrome({
  children,
  voiceOptions,
  onVoiceSelect,
  voiceRefinements,
  onVoiceRefine,
}: {
  children: ReactNode;
  /** The voices this Bot's replies can be read in; absent when there are none. */
  voiceOptions?: BotVoiceOption[];
  /** The operator picked a row: a voice, or undefined for the platform's default. */
  onVoiceSelect?: (identifier: string | undefined) => void;
  /** The refinement rows for the voice this Bot is stored with; absent when none is. */
  voiceRefinements?: BotVoiceRefinementRow[];
  /** The operator picked a step: the field it writes, and the value it carries. */
  onVoiceRefine?: (field: BotVoiceRefinementField, value: number) => void;
}) {
  const showVoice = !!voiceOptions?.length && !!onVoiceSelect;
  const showRefine = !!voiceRefinements?.length && !!onVoiceRefine;

  return (
    <View style={styles.body}>
      {showVoice ? (
        <View style={styles.voice}>
          <Text variant="eyebrow" color="tertiary">
            Voice
          </Text>
          <View style={styles.voiceRows}>
            {voiceOptions?.map((option) => (
              <Chip
                key={option.identifier ?? 'default'}
                label={option.label}
                selected={option.selected}
                onPress={() => onVoiceSelect?.(option.identifier)}
              />
            ))}
          </View>
          {showRefine ? (
            <View style={styles.refine}>
              <Text variant="caption" color="tertiary">
                {BOT_VOICE_RANGE_COPY}
              </Text>
              {voiceRefinements?.map((row) => (
                <View key={row.field} style={styles.refineRow}>
                  <Text variant="caption" color="secondary">
                    {row.label}
                  </Text>
                  {row.steps.map((step) => (
                    <Chip
                      key={step.value}
                      label={step.label}
                      selected={step.selected}
                      onPress={() => onVoiceRefine?.(row.field, step.value)}
                    />
                  ))}
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: Spacing.two },
  voice: { paddingHorizontal: Spacing.two, gap: Spacing.two },
  voiceRows: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one },
  refine: { gap: Spacing.two },
  refineRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: Spacing.one,
  },
});
