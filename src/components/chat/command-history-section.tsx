import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';

import { Button, ListRow, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useTokens } from '@/hooks/use-tokens';
import {
  commandHistoryEmptyCopy,
  commandHistoryRowTitle,
  commandHistoryToggleLabel,
  commandHistoryVisible,
  commandHistoryWindowCopy,
} from '@/lib/gateway/command-history';
import { commandTranscriptMarkdown } from '@/lib/gateway/transcript-export';
import { haptics } from '@/lib/haptics';

/**
 * The command transcript for this gateway + session: every slash execution
 * the provider already records and rehydrates. Display only — the entries
 * are held in memory, so this section reads them with no new fetch and no
 * new store. Collapsed by default; an empty store reads as "none yet",
 * never a blank block. The one way out of the app is the copy action, which
 * hands the held entries to the Markdown composer and nothing else.
 *
 * The composer redacts an entry's raw output unless it is asked for that
 * explicitly, so the ask lives here: a switch beside the copy action, off by
 * default, deciding whether the copied Markdown carries each entry's tool
 * calls. It is this section's own state and it reaches nothing — flipping it
 * copies nothing, stores nothing, and leaves the composer's own rules alone.
 */
export function CommandHistorySection() {
  const { commandTranscripts } = useGateway();
  const tokens = useTokens();
  const [open, setOpen] = useState(false);
  const [includeRaw, setIncludeRaw] = useState(false);

  const rows = commandHistoryVisible(commandTranscripts).map((entry) => ({
    id: entry.id,
    title: commandHistoryRowTitle(entry),
    subtitle: entry.summary,
  }));
  const windowCopy = commandHistoryWindowCopy(commandTranscripts.length);

  const copyMarkdown = async () => {
    await Clipboard.setStringAsync(
      commandTranscriptMarkdown(commandTranscripts, { includeRaw }),
    );
    await haptics.success();
  };

  return (
    <View style={styles.block}>
      <Text variant="title">Command history</Text>
      <Text variant="caption" color="secondary">
        Slash commands run in this session, newest first.
      </Text>
      <Button
        label={commandHistoryToggleLabel(open, commandTranscripts.length)}
        variant="ghost"
        onPress={() => setOpen(!open)}
      />
      {open ? (
        rows.length === 0 ? (
          <Text variant="caption" color="tertiary" style={styles.empty}>
            {commandHistoryEmptyCopy()}
          </Text>
        ) : (
          <>
            {rows.map((row) => (
              <ListRow key={row.id} title={row.title} subtitle={row.subtitle} />
            ))}
            {windowCopy ? (
              <Text variant="micro" color="tertiary">
                {windowCopy}
              </Text>
            ) : null}
            <View style={styles.rawToggle}>
              <View style={styles.rawToggleCopy}>
                <Text variant="body">Include raw output</Text>
                <Text variant="caption" color="secondary">
                  The tool calls and payloads, verbatim. Off keeps them redacted.
                </Text>
              </View>
              <Switch
                value={includeRaw}
                onValueChange={setIncludeRaw}
                trackColor={{ true: tokens.accent, false: tokens.border }}
                thumbColor={tokens.textPrimary}
                accessibilityLabel="Include raw output"
                accessibilityState={{ checked: includeRaw }}
              />
            </View>
            <Button
              label="Copy Markdown"
              variant="ghost"
              size="sm"
              onPress={() => void copyMarkdown()}
            />
          </>
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: Spacing.two, paddingHorizontal: Spacing.two },
  empty: { paddingBottom: Spacing.two },
  rawToggle: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  rawToggleCopy: { flex: 1, minWidth: 0 },
});
