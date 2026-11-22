import { StyleSheet, View } from 'react-native';

import { Chip } from '@/components/ui';
import { Spacing, Typography } from '@/constants/tokens';

export type BackendFilter = { id: string; label: string };

/**
 * The vertical box one backend chip row occupies: a Chip's caption line at the
 * largest scale its type allows (1.4x, `variantFontScaleCap` in ui/Text), that
 * line's vertical padding and hairline, plus the row's gap below.
 *
 * A screen that reserves this box (the Home roster does) keeps its list rows on
 * the same pixels whether the chips are drawn or not: a runtime that only
 * resolves after first paint fills the reserved strip instead of pushing every
 * row down under a finger already reaching for a Bot (VS-135).
 */
// A partial `@/constants/tokens` mock (several mounted suites stub the token
// module) leaves Typography undefined at import time, so the reservation must
// still resolve to the real caption line height when the tokens are present and
// must not crash the module when they are not. 18 is `Typography.caption`'s
// lineHeight in constants/tokens.ts.
const CAPTION_LINE_HEIGHT = Typography?.caption?.lineHeight ?? 18;

export const BACKEND_FILTER_SLOT_HEIGHT = Math.ceil(
  CAPTION_LINE_HEIGHT * 1.4 + 2 * (Spacing.one + 2) + 2 * StyleSheet.hairlineWidth + Spacing.two,
);

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
