import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Chip, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { botChromeToggleLabel } from '@/lib/gateway/bot-chrome';
import type { BotVoiceOption } from '@/lib/voice/bot-voices';

/**
 * The Bot Chat strip: one toggle, and — for a Bot whose replies this device has
 * a voice to read them in — the voice they are read in. The rows are the pure
 * fold's (`src/lib/voice/bot-voices.ts`), so this file authors no order and no
 * copy of its own, and a device the platform named no voice for is handed no
 * options at all: it draws no Voice section rather than a lone row that could
 * not change anything.
 */
export function BotChrome({
  children,
  voiceOptions,
  onVoiceSelect,
}: {
  children: ReactNode;
  /** The voices this Bot's replies can be read in; absent when there are none. */
  voiceOptions?: BotVoiceOption[];
  /** The operator picked a row: a voice, or undefined for the platform's default. */
  onVoiceSelect?: (identifier: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const showVoice = !!voiceOptions?.length && !!onVoiceSelect;

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
});
