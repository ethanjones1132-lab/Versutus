import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Button, ListRow, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import {
  TOOLSETS_PANE_MAX_HEIGHT,
  toolsetsListCopy,
  toolsetsToggleLabel,
  type Toolset,
  type ToolsetsState,
} from '@/lib/gateway/toolsets';

export function ToolsPane({
  toolsets,
  loaded,
  failed,
  onRetry,
}: {
  toolsets: Toolset[];
  loaded: boolean;
  failed: boolean;
  /** Re-run the same `tools.list` read the surface effect runs. */
  onRetry?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const state: ToolsetsState = { toolsets, loaded, failed };
  const copy = toolsetsListCopy(state);

  return (
    <View style={styles.wrap}>
      <Button
        label={toolsetsToggleLabel(state, open)}
        variant="ghost"
        size="md"
        onPress={() => setOpen((value) => !value)}
      />
      {open ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.body}
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          {copy ? (
            <Text variant="micro" color="secondary">
              {copy}
            </Text>
          ) : null}
          {!loaded && failed && onRetry ? (
            <Button label="Retry" variant="ghost" size="sm" onPress={onRetry} />
          ) : null}
          {toolsets.map((toolset) => (
            <ListRow
              key={toolset.name}
              title={toolset.name}
              subtitle={toolset.description || undefined}
            />
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: Spacing.three, paddingBottom: Spacing.one },
  scroll: { maxHeight: TOOLSETS_PANE_MAX_HEIGHT },
  body: { gap: Spacing.one, paddingTop: Spacing.one },
});
