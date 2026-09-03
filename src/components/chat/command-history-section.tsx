import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, ListRow, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import {
  commandHistoryEmptyCopy,
  commandHistoryRowTitle,
  commandHistoryToggleLabel,
  commandHistoryVisible,
} from '@/lib/gateway/command-history';

/**
 * The command transcript for this gateway + session: every slash execution
 * the provider already records and rehydrates. Display only — the entries
 * are held in memory, so this section reads them with no new fetch and no
 * new store. Collapsed by default; an empty store reads as "none yet",
 * never a blank block.
 */
export function CommandHistorySection() {
  const { commandTranscripts } = useGateway();
  const [open, setOpen] = useState(false);

  const rows = commandHistoryVisible(commandTranscripts).map((entry) => ({
    id: entry.id,
    title: commandHistoryRowTitle(entry),
    subtitle: entry.summary,
  }));

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
          rows.map((row) => (
            <ListRow key={row.id} title={row.title} subtitle={row.subtitle} />
          ))
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: Spacing.two, paddingHorizontal: Spacing.two },
  empty: { paddingBottom: Spacing.two },
});
