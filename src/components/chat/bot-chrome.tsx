import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Chip, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { botChromeToggleLabel } from '@/lib/gateway/bot-chrome';
import {
  BOT_VOICE_RANGE_COPY,
  type BotVoiceOption,
  type BotVoiceRefinementField,
  type BotVoiceRefinementRow,
} from '@/lib/voice/bot-voices';

/**
 * The Bot Chat strip: one toggle, and — for a Bot whose replies this device has
 * a voice to read them in — the voice they are read in, with the rate and
 * pitch that voice speaks at. The rows are the pure fold's
 * (`src/lib/voice/bot-voices.ts`), so this file authors no order, no step and
 * no copy of its own, and a device the platform named no voice for is handed
 * no options at all: it draws no Voice section rather than a lone row that
 * could not change anything. The refinement rows are the same fold's answer
 * for the voice this Bot is stored with, which is why a Bot on the platform's
 * own default is offered none: there is no entry to write one to.
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
  const [open, setOpen] = useState(false);
  const showVoice = !!voiceOptions?.length && !!onVoiceSelect;
  const showRefine = !!voiceRefinements?.length && !!onVoiceRefine;

  return (
    <View>
      <View style={styles.toggle}>
        <Button
          label={botChromeToggleLabel(open)}
          variant="ghost"
          size="sm"
          expanded={open}
          onPress={() => setOpen((value) => !value)}
        />
      </View>
      {open ? (
        <>
          {showVoice ? (
            <View style={styles.voice}>
              <Text variant="micro" color="secondary">
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
                  <Text variant="micro" color="secondary">
                    {BOT_VOICE_RANGE_COPY}
                  </Text>
                  {voiceRefinements?.map((row) => (
                    <View key={row.field} style={styles.refineRow}>
                      <Text variant="micro" color="secondary">
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
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  toggle: { paddingHorizontal: Spacing.three, paddingBottom: Spacing.one },
  voice: { paddingHorizontal: Spacing.three, paddingBottom: Spacing.one, gap: Spacing.one },
  voiceRows: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one },
  refine: { gap: Spacing.one },
  refineRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: Spacing.one,
  },
});
