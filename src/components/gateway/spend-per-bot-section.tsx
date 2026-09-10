import { StyleSheet, View } from 'react-native';

import { Card, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { SESSION_SPEND_LIST_LIMIT } from '@/lib/gateway/session-analytics';
import {
  botSpendCapCopy,
  botSpendRowCopy,
  botSpendSectionBasis,
  SPEND_PER_BOT_DEGRADED_COPY,
  spendBasisCopy,
  type BotSpendReport,
} from '@/lib/gateway/spend-report';

/**
 * P5's per-Bot breakdown, as the rows `readBotSpend` folded.
 *
 * The read and the fold live in `src/lib/gateway/spend-report.ts`; this is
 * only their surface, so no number is computed here. Each row prints
 * `botSpendRowCopy` — its own tokens, cost and basis — and the section header
 * comes from `spendBasisCopy` only when every row agrees on one basis. A
 * roster that mixes an actual charge with an estimate gets no header and lets
 * each row's own basis speak; that is the one fact a header may not blur.
 *
 * Each row's number was read over its own scoped catalogue, and every one of
 * those reads stopped at `SESSION_SPEND_LIST_LIMIT`. `botSpendCapCopy` names
 * that bound once under the rows, so a Bot with a longer history than the cap
 * cannot have its number read as its whole history — and because the read is
 * per row, the section keeps that line even where the basis header is
 * withdrawn.
 *
 * Three states stay distinct, because they are three different facts:
 *   - `degraded` — the gateway cannot be asked per Bot at all: the line that
 *     says why, and no rows, so the gateway total above is the whole answer;
 *   - an empty roster — no section at all, never an empty list, which would
 *     read as "no Bot spent anything" on a gateway that simply has no Bots;
 *   - rows — one line per Bot, a failed read named on its own row rather than
 *     dropped, since a dropped Bot reads as a Bot that spent nothing.
 */
export function SpendPerBotSection({ report }: { report: BotSpendReport }) {
  if (report.degraded) {
    return (
      <Card variant="surface" padding={Spacing.three} style={styles.card}>
        <Text variant="caption" color="secondary">
          {SPEND_PER_BOT_DEGRADED_COPY}
        </Text>
      </Card>
    );
  }

  // An empty roster is not an empty breakdown.
  if (report.rows.length === 0) return null;

  const shared = botSpendSectionBasis(report.rows);
  return (
    <Card variant="surface" padding={Spacing.three} style={styles.card}>
      <Text variant="headline">Spend by Bot</Text>
      {shared ? (
        <Text variant="caption" color="secondary">
          {spendBasisCopy(shared)}
        </Text>
      ) : null}
      {report.rows.map((row) => (
        <View key={row.botId} style={styles.row}>
          <Text>{row.label}</Text>
          <Text variant="caption" color="secondary">
            {botSpendRowCopy(row)}
          </Text>
        </View>
      ))}
      <Text variant="micro" color="tertiary">
        {botSpendCapCopy(SESSION_SPEND_LIST_LIMIT)}
      </Text>
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
