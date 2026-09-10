import { StyleSheet, View } from 'react-native';

import { Card, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import {
  spendSessionCapCopy,
  spendSessionRowCopy,
  type SpendSessionRow,
} from '@/lib/gateway/spend-report';

/**
 * P5's per-session table: the rows `spendSessionRows` ordered, as the one
 * catalogue read returned them.
 *
 * The fold, its ordering and every string live in
 * `src/lib/gateway/spend-report.ts`; this is only their surface, so no number
 * is computed here. Each row prints the session's name and then
 * `spendSessionRowCopy` — its tokens, its cost with the basis that cost is
 * claimed on, and how long ago it ran.
 *
 * Two states, and both are honest:
 *   - no rows — nothing at all, never an empty table. An unread catalogue is
 *     named above (the total's own copy) and a read that answered with no
 *     sessions has no sessions to list; an empty frame under either would read
 *     as "nothing was spent";
 *   - rows — the caption names the read's bound, so a capped list says older
 *     sessions are past it rather than reading as the whole catalogue.
 */
export function SpendSessionTable({ rows }: { rows: SpendSessionRow[] }) {
  if (rows.length === 0) return null;

  return (
    <Card variant="surface" padding={Spacing.three} style={styles.card}>
      <Text variant="headline">Sessions by cost</Text>
      <Text variant="caption" color="secondary">
        {spendSessionCapCopy(rows.length)}
      </Text>
      {rows.map((row) => (
        <View key={row.key} style={styles.row}>
          <Text numberOfLines={1}>{row.label}</Text>
          <Text variant="caption" color="secondary">
            {spendSessionRowCopy(row)}
          </Text>
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: Spacing.two,
  },
  row: {
    gap: Spacing.one,
  },
});
