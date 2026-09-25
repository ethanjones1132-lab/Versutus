import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Radius, Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';

import { GlassSurface } from './GlassSurface';
import { ListRow, type ListRowProps } from './ListRow';
import { Text } from './Text';
import type { GlassVariant } from './types';

export type RowGroupProps = {
  /**
   * The group's name, set in plain words above the rows. Sentence case and
   * secondary — never the violet ALL-CAPS eyebrow the card stacks used to
   * print (`docs/visual-direction-2026-09.md`: settings and activity are
   * grouped rows, not marketing cards).
   */
  label?: string;
  /**
   * The paragraph a card used to carry as body copy, now a quiet footnote
   * under the rows: it explains the group, it does not headline it.
   */
  hint?: string;
  /** Surface the group sits on. Defaults to the elevated step, like a card. */
  variant?: GlassVariant;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
};

/**
 * One grouped block of rows on the stage: a plain label, a single quiet fill,
 * and the rows inside it.
 *
 * The fill is the only chrome. Rows are told apart by the elevation step and
 * the gap between them — never by a hairline, never by a ring per row (S4b).
 * The one edge a group does draw is a *selected* row's, because a selection
 * carries meaning rather than decoration.
 */
export function RowGroup({ label, hint, variant = 'surface', style, children }: RowGroupProps) {
  return (
    <View style={[styles.group, style]}>
      {label ? (
        <Text variant="caption" color="secondary" style={styles.label}>
          {label}
        </Text>
      ) : null}
      <GlassSurface variant={variant} radius={Radius.lg} padding={0} style={styles.fill}>
        <View style={styles.rows}>{children}</View>
      </GlassSurface>
      {hint ? (
        <Text variant="micro" color="tertiary" style={styles.hint}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export type RowGroupRowProps = ListRowProps;

/**
 * A row inside a group: label, the value or control on the right, a quiet
 * detail line, and a chevron when the row opens something. It is the shared
 * `ListRow` — same 48pt target, haptics, press scale and screen-reader
 * wiring — with the group's own insets and the selected-row edge applied.
 */
export function RowGroupRow({ selected, detail, accessibilityLabel, style, ...rest }: RowGroupRowProps) {
  const tokens = useTokens();

  return (
    <ListRow
      {...rest}
      selected={selected}
      // A grouped row can draw three lines, so the derived announcement has to
      // say all three: left undefined when there is no detail line, `ListRow`
      // derives the label it always has.
      accessibilityLabel={
        accessibilityLabel ?? (detail ? [rest.title, rest.subtitle, detail].filter(Boolean).join(', ') : undefined)
      }
      style={[styles.row, selected === true ? { borderColor: tokens.accent } : null, style]}
    />
  );
}

const styles = StyleSheet.create({
  group: {
    gap: Spacing.two,
  },
  label: {
    // A group name is read before its rows, so it sits one step above the
    // detail lines and one step below the screen title — no caps, no brand.
    paddingHorizontal: Spacing.two,
  },
  fill: {
    overflow: 'hidden',
  },
  rows: {
    paddingVertical: Spacing.one,
    gap: Spacing.one,
  },
  row: {
    // Flush to the fill: the group already draws the edge, so the row must not
    // re-inset itself and read as a second margin.
    paddingHorizontal: Spacing.three - 2,
    borderRadius: Radius.sm,
    // Transparent by default, so a selected row's edge is the only one drawn.
    borderWidth: 1,
    borderColor: 'transparent',
  },
  hint: {
    paddingHorizontal: Spacing.two,
    lineHeight: 16,
  },
});
