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
// That empty-device rule is about the CARDS, never about this section: the
// weekly report is opted into from here (D3 Build 5), so a device that has run
// nothing — exactly the device the report exists to bring back — still gets
// this section, the read's window line and the opt-in, and no card at all.
//
// The tap is the filter: a card hands the tab its bucket, which puts the run
// list above on that Bot's runs. While a filter is set, the way back to the
// unfiltered list is a control here rather than something to hunt for.
//
// The weekly operator report is opted into from here (D3 Build 5) — one local
// notice, off by default. The switch paints the device's stored flag and
// nothing else, so it can never show "on" for a notice the phone does not hold;
// and an opt-in the phone declined says so, in the module's own words, so a
// device that refused the notice does not read like one nobody ever asked.

import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';

import { Badge, Button, Card, Divider, ListRow, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { ActivityRun } from '@/lib/gateway/runs';
import {
  loadWeeklyReportOptIn,
  setWeeklyReportOptIn,
} from '@/lib/notifications/weekly-report';
import {
  WEEKLY_REPORT_OPT_IN_LABEL,
  WEEKLY_REPORT_OPT_IN_SUMMARY,
  weeklyReportOptInHolds,
  weeklyReportRefusedBy,
  weeklyReportRefusalCopy,
  type WeeklyReportRefusal,
} from '@/lib/notifications/weekly-report-schedule';
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
  const tokens = useTokens();
  // Fold the list the tab was handed, exactly as the tab's own filter does.
  const cards = useMemo(() => buildScorecards(runs), [runs]);

  // Off until the stored flag says otherwise: D3's weekly report is opt-in and
  // a device that never asked holds no flag at all.
  const [weeklyReport, setWeeklyReport] = useState(false);
  // The refusal the last attempt met, or null. Only an attempt can set it, so
  // a device nobody ever asked never shows one.
  const [weeklyReportRefusal, setWeeklyReportRefusal] = useState<WeeklyReportRefusal | null>(null);

  useEffect(() => {
    let live = true;
    // `loadWeeklyReportOptIn` never rejects — a store it cannot read reads as
    // off, the fail-closed direction.
    void loadWeeklyReportOptIn().then((enabled) => {
      if (live) setWeeklyReport(enabled);
    });
    return () => {
      live = false;
    };
  }, []);

  /**
   * The switch answers the finger, then the device has the last word: a
   * declined permission or a failed schedule leaves no opt-in behind, so the
   * control snaps back instead of promising a notice that is not there — and
   * the refusal it met is named below it rather than left looking like a
   * report nobody asked for.
   */
  const handleWeeklyReport = (next: boolean) => {
    setWeeklyReport(next);
    setWeeklyReportRefusal(null);
    void setWeeklyReportOptIn(next).then((state) => {
      setWeeklyReport(weeklyReportOptInHolds(state));
      setWeeklyReportRefusal(weeklyReportRefusedBy(state));
    });
  };

  // No runs on this device is no card — a placeholder would read as every Bot
  // doing fine — but never no section: the weekly opt-in below is the one
  // control a device with no runs still needs, and it has to be reachable
  // before a first run lands.
  const hasCards = cards.length > 0;

  return (
    <Card padding={Spacing.three} style={styles.card}>
      <Text variant="title">Scorecards</Text>

      {/* The window is the read's, so it is named once for the cards below
          rather than repeated identically on each one. It names an empty read
          too, which is why it sits outside the card decision. */}
      <Text variant="caption" color="secondary">
        {scorecardWindowCopy(runs.length)}
      </Text>

      {hasCards
        ? cards.map((card) => {
            // The one visual difference between the cards: the one whose runs
            // the list above is showing. (ListRow's own `selected` is the
            // backend picker's announced state, and
            // `list-row-selected-state-test.ts` keeps that pass scoped to it.)
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
          })
        : null}

      {filter ? (
        <Button
          label="Show all runs"
          variant="secondary"
          size="sm"
          onPress={() => onSelect(null)}
        />
      ) : null}

      {/* One local notice a week, off by default — the label and the line are
          the module's, so the honesty rule is pinned where it is decided. It
          renders whatever the read held, cards or none: this is the row a
          device with no runs is here for. */}
      <Divider />
      <View style={styles.optIn}>
        <View style={styles.optInCopy}>
          <Text variant="body">{WEEKLY_REPORT_OPT_IN_LABEL}</Text>
          <Text variant="caption" color="secondary">
            {WEEKLY_REPORT_OPT_IN_SUMMARY}
          </Text>
        </View>
        <Switch
          value={weeklyReport}
          onValueChange={handleWeeklyReport}
          trackColor={{ true: tokens.accent, false: tokens.border }}
          thumbColor={tokens.textPrimary}
          accessibilityLabel={WEEKLY_REPORT_OPT_IN_LABEL}
          accessibilityState={{ checked: weeklyReport }}
        />
      </View>

      {/* A device that refused the notice says why, in the module's own
          words: an off switch alone cannot tell it from a device nobody ever
          asked. It clears with every attempt, so it never outlives the try
          that met it. */}
      {weeklyReportRefusal ? (
        <Text variant="caption" color="accentWarm">
          {weeklyReportRefusalCopy(weeklyReportRefusal)}
        </Text>
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
  optIn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  optInCopy: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
});
