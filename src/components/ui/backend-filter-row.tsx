import { StyleSheet, View } from 'react-native';

import { Chip } from '@/components/ui';
import { Spacing } from '@/constants/tokens';

export type BackendFilter = { id: string; label: string };

export function BackendFilterRow({
  filters,
  selected,
  onSelect,
  accessibilityLabel,
}: {
  filters: readonly BackendFilter[];
  selected: string | null | undefined;
  onSelect: (backendId: string | undefined) => void;
  accessibilityLabel: string;
}) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel} style={styles.row}>
      <Chip label="All" selected={selected == null} onPress={() => onSelect(undefined)} />
      {filters.map((filter) => (
        <Chip
          key={filter.id}
          label={filter.label}
          selected={selected === filter.id}
          onPress={() => onSelect(filter.id)}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two, paddingHorizontal: Spacing.one, marginBottom: Spacing.two },
});
