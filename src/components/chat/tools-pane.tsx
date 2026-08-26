import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, ListRow, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import {
  toolsetsListCopy,
  toolsetsToggleLabel,
  type Toolset,
  type ToolsetsState,
} from '@/lib/gateway/toolsets';

export function ToolsPane({
  toolsets,
  loaded,
  failed,
}: {
  toolsets: Toolset[];
  loaded: boolean;
  failed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const state: ToolsetsState = { toolsets, loaded, failed };
  const copy = toolsetsListCopy(state);

  return (
    <View style={styles.wrap}>
      <Button
        label={toolsetsToggleLabel(state, open)}
        variant="ghost"
        size="sm"
        onPress={() => setOpen((value) => !value)}
      />
      {open ? (
        <View style={styles.body}>
          {copy ? (
            <Text variant="micro" color="secondary">
              {copy}
            </Text>
          ) : null}
          {toolsets.map((toolset) => (
            <ListRow
              key={toolset.name}
              title={toolset.name}
              subtitle={toolset.description || undefined}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: Spacing.three, paddingBottom: Spacing.one },
  body: { gap: Spacing.one, paddingTop: Spacing.one },
});
