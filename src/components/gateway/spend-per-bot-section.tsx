import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { SESSION_SPEND_LIST_LIMIT } from '@/lib/gateway/session-analytics';
import { botBudget, budgetRowCopy, type BotBudgets } from '@/lib/gateway/budgets';
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
 * D5 adds a per-Bot spend cap to each row: `budgets` + `onSetBudget` are the
 * optional pair that turns the read into a control. With neither, this is the
 * read-only section P5 shipped. A cap is this device's and the enforcement is
 * client-side — the row copy says "Budget", never "quota".
 *
 * Three states stay distinct, because they are three different facts:
 *   - `degraded` — the gateway cannot be asked per Bot at all: the line that
 *     says why, and no rows, so the gateway total above is the whole answer;
 *   - an empty roster — no section at all, never an empty list, which would
 *     read as "no Bot spent anything" on a gateway that simply has no Bots;
 *   - rows — one line per Bot, a failed read named on its own row rather than
 *     dropped, since a dropped Bot reads as a Bot that spent nothing.
 */
export function SpendPerBotSection({
  report,
  gatewayId,
  budgets,
  onSetBudget,
}: {
  report: BotSpendReport;
  gatewayId?: string;
  budgets?: BotBudgets;
  onSetBudget?: (botId: string, cap: number | undefined) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

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

  const canEdit = Boolean(onSetBudget && gatewayId);
  const shared = botSpendSectionBasis(report.rows);
  return (
    <Card variant="surface" padding={Spacing.three} style={styles.card}>
      <Text variant="headline">Spend by Bot</Text>
      {shared ? (
        <Text variant="caption" color="secondary">
          {spendBasisCopy(shared)}
        </Text>
      ) : null}
      {report.rows.map((row) => {
        const cap = canEdit && budgets && gatewayId ? botBudget(budgets, gatewayId, row.botId) : undefined;
        return (
          <View key={row.botId} style={styles.row}>
            <Text>{row.label}</Text>
            <Text variant="caption" color="secondary">
              {botSpendRowCopy(row)}
            </Text>
            {canEdit ? (
              editing === row.botId ? (
                <View style={styles.editor}>
                  <TextField value={draft} onChangeText={setDraft} placeholder="5" />
                  <Button
                    label="Save cap"
                    size="sm"
                    onPress={() => {
                      const value = Number.parseFloat(draft);
                      onSetBudget?.(row.botId, Number.isFinite(value) && value > 0 ? value : undefined);
                      setEditing(null);
                    }}
                  />
                  <Button
                    label="Clear"
                    variant="ghost"
                    size="sm"
                    onPress={() => {
                      onSetBudget?.(row.botId, undefined);
                      setEditing(null);
                    }}
                  />
                </View>
              ) : (
                <View style={styles.editor}>
                  <Text variant="micro" color="tertiary">
                    {budgetRowCopy(cap)}
                  </Text>
                  <Button
                    label={cap === undefined ? 'Set cap' : 'Change cap'}
                    variant="ghost"
                    size="sm"
                    onPress={() => {
                      setDraft(cap === undefined ? '' : String(cap));
                      setEditing(row.botId);
                    }}
                  />
                </View>
              )
            ) : null}
          </View>
        );
      })}
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
  editor: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
});
