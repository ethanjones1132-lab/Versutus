// ─── Scorecards ───────────────────────────────────────────────────
// D3's per-Bot track record on the Activity tab (FUTURE-ITEMS.md §D3 Build 3):
// one card per Bot, folded from the runs this device recorded. The fold and
// every string it prints live in `@/lib/fleet/scorecard`; this is only their
// surface, so no number is computed here.
//
// Honesty: a card is a count of runs this app saw, never a gateway-side total
// — the module's footer says so once, under the cards. A Bot this device holds
// no runs for gets no card, because an empty card would read as a Bot that
// fails at nothing; and no roster is read here, so the section can only ever
// name a Bot the runs already named.
//
// The tap is the filter: a card hands the tab its bucket, which puts the run
// list above on that Bot's runs. While a filter is set, the way back to the
// unfiltered list is a control here rather than something to hunt for.

import { useMemo } from 'react';
import { StyleSheet } from 'react-native';

import { Badge, Button, Card, ListRow, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import type { ActivityRun } from '@/lib/gateway/runs';
import {
  buildScorecards,
  scorecardBotLabel,
  scorecardFateCopy,
  scorecardWindowCopy,
  SCORECARD_FOOTER_COPY,
  type ScorecardFilter,
} from '@/lib/fleet/scorecard';

export function ScorecardsSection({
  runs,
  filter,
  onSelect,
}: {
  /** The runs this device persisted — the whole read, never the filtered view. */
  runs: readonly ActivityRun[];
  /** The bucket the tab is filtered to, or null for no filter. */
  filter: ScorecardFilter;
  onSelect: (filter: ScorecardFilter) => void;
}) {
  // Fold the list the tab was handed, exactly as the tab's own filter does.
  const cards = useMemo(() => buildScorecards(runs), [runs]);

  // No runs on this device is no section at all: a placeholder would read as
  // every Bot doing fine, and this surface has nothing to say about a device
  // that has started nothing.
  if (cards.length === 0) return null;

  return (
    <Card padding={Spacing.three} style={styles.card}>
      <Text variant="title">Scorecards</Text>

      {/* The window is the read's, so it is named once for the cards below
          rather than repeated identically on each one. */}
      <Text variant="caption" color="secondary">
        {scorecardWindowCopy(runs.length)}
      </Text>

      {cards.map((card) => {
        // The one visual difference between the cards: the one whose runs the
        // list above is showing. (ListRow's own `selected` is the backend
        // picker's announced state, and `list-row-selected-state-test.ts`
        // keeps that pass scoped to it.)
        const showing = filter ? card.botId === filter.botId : false;
        return (
          <ListRow
            key={card.botId ?? 'unattributed'}
            title={scorecardBotLabel(card.botId)}
            subtitle={scorecardFateCopy(card.fates)}
            onPress={() => onSelect({ botId: card.botId })}
            trailing={showing ? <Badge label="Showing" tone="accent" /> : undefined}
            accessibilityHint="Shows this Bot's runs in the list above"
            style={styles.row}
          />
        );
      })}

      {filter ? (
        <Button
          label="Show all runs"
          variant="secondary"
          size="sm"
          onPress={() => onSelect(null)}
        />
      ) : null}

      <Text variant="micro" color="tertiary">
        {SCORECARD_FOOTER_COPY}
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: Spacing.two,
  },
  row: {
    paddingHorizontal: 0,
  },
});
