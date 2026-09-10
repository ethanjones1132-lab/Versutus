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
// A card's line also carries the median span its own runs ended on, when the
// fold can back one — read from that card's own rows, through the same
// attribution rule the fold bucketed by, so no card can borrow another's runs.
// A card whose rows carry no span this device watched end keeps its counts and
// says no duration, rather than a number it cannot back.
//
// The line also carries the share those fates earned, from the card's own
// counts: `complete` over the runs that reached a verdict, so a cancelled run
// (the operator's own stop) and an unresolved one (a fate this device never
// learned) never depress a rate they did not earn, and a card with nothing
// decided says no rate rather than a percentage nothing backs.
//
// The line carries the approval pressure those same rows recorded too, and by
// the same rule: what the operator decided is read off the rows that decided
// it, a request still blocked on them is named, and a card whose rows met no
// gate says nothing about approvals at all. The line itself is composed by the
// fold, to the room a row's one clipped line has: a fact this card does not
// hold takes no room, and a card that cannot hold everything drops whole facts
// — least important first — rather than having one cut mid-number by the
// renderer. Nothing is joined here, so the rule is the module's own and is
// pinned there.
//
// `ListRow` announces a row with the string it draws, so the composed line is
// also what a screen reader reads — and a fact the line could not hold would be
// missing from the sentence as well as the pixels. The card therefore hands the
// row the module's other composition of the SAME facts: the whole card, no
// budget, under the card's own title. One `facts` object is handed to both, so
// the drawn line and the announcement cannot be composed from different sets.
//
// The line also carries the gateway's own verdict on this Bot's routines, when
// the job list names any: the jobs are grouped by the `[bot:<name>]` naming
// convention in the fold and each card looks its own bucket up, so a card can
// never borrow another Bot's routines. That number is gateway-side, so it keeps
// its own words — "N routines · <verdict>" — rather than being folded into the
// run-derived counts, and a Bot with no routines says nothing about them.
//
// P5's spend arrives the same way, as rows the tab read: `withSpend` merges
// each Bot's row onto the card that Bot's runs produced, and the card prints
// the row's own wording. A card the read holds no row for says nothing about
// spend rather than a zero nobody read, and a Bot with spend but no runs here
// gets no card at all — the cards stay the runs this device saw.
//
// That empty-device rule is about the CARDS, never about this section: the
// weekly report is opted into from here (D3 Build 5), so a device that has run
// nothing — exactly the device the report exists to bring back — still gets
// this section, the read's window line and the opt-in, and no card at all.
//
// The tap is the filter: a card hands the tab its bucket, which puts the run
// list above on that Bot's runs. While a filter is set, the way back to the
// unfiltered list is a control here rather than something to hunt for. The
// filtered card says so twice off the one `showing` this file computes: the
// module's word in a badge for the eye, and the module's sentence appended to
// the announcement — a badge is a visual inside a row the row says nothing
// about, so without the second the filtered card would read like every other.
// Its HINT and its CHEVRON ride that same state too, and those are the two
// things the state takes away: both answer what the tap does next, and on this
// card the tap re-applies the filter the list already carries. So the module
// hands it no hint at all instead of promising a list the tap cannot show, and
// no trailing chevron — the kit's visual for "there is a surface this way", on
// a row with no further surface to open. The wording of the hint every other
// card carries is the module's as well, so no state here is worded on this
// surface.
//
// The weekly operator report is opted into from here (D3 Build 5) — one local
// notice, off by default. The switch paints the state this device actually
// holds, never a flag on its own, so it cannot show "on" for a notice the tray
// will not show: not after an attempt the phone declined, and not after a
// permission revoked in Settings under a notice already scheduled. Either way
// the module's own words say why, so a device that refused the notice does not
// read like one nobody ever asked. That state is read on every return to this
// surface, not once at mount: a tab screen keeps its children alive for the
// life of the app, so a revocation the app lived through is only ever caught
// on the way back in — and both ways in, focus and foreground, are the repo's
// own (cron-section.tsx, index.tsx). A read never outranks the operator's own
// answer, either: an attempt bumps the token the read captured before its
// await, so a read that started before the tap paints nothing.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { AppState, StyleSheet, Switch, View } from 'react-native';

import { Badge, Button, Card, Divider, ListRow, Text } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { useTokens } from '@/hooks/use-tokens';
import type { CronJob } from '@/lib/gateway/cron';
import type { ActivityRun } from '@/lib/gateway/runs';
import type { BotSpendRow } from '@/lib/gateway/spend-report';
import {
  readWeeklyReportOptIn,
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
  filterRunsByBot,
  medianRunMs,
  scorecardApprovalCopy,
  scorecardApprovals,
  scorecardBotLabel,
  scorecardCardAnnouncement,
  scorecardCardChevron,
  scorecardCardHint,
  scorecardCardLine,
  scorecardDurationCopy,
  scorecardFateCopy,
  scorecardRoutineCopy,
  scorecardRoutineHealth,
  scorecardSpendCopy,
  scorecardSuccessCopy,
  scorecardSuccessRate,
  scorecardWindowCopy,
  withSpend,
  SCORECARD_FOOTER_COPY,
  SCORECARD_SHOWING_LABEL,
  type ScorecardFilter,
} from '@/lib/fleet/scorecard';

export function ScorecardsSection({
  runs,
  jobs,
  spendRows,
  filter,
  onSelect,
}: {
  /** The runs this device persisted — the whole read, never the filtered view. */
  runs: readonly ActivityRun[];
  /** The gateway's own scheduled jobs, for the routine health a card can carry. */
  jobs: readonly CronJob[];
  /**
   * P5's per-Bot spend, as the tab's own read folded it. Merged onto the cards
   * by the fold's id rule; a Bot with spend but no runs here still gets no card.
   */
  spendRows: readonly BotSpendRow[];
  /** The bucket the tab is filtered to, or null for no filter. */
  filter: ScorecardFilter;
  onSelect: (filter: ScorecardFilter) => void;
}) {
  const tokens = useTokens();
  // Fold the list the tab was handed, exactly as the tab's own filter does,
  // then merge the spend read onto it — the cards decide the list, so a Bot
  // with spend but no runs on this device cannot appear as one that fails at
  // nothing.
  const cards = useMemo(() => withSpend(buildScorecards(runs), spendRows), [runs, spendRows]);
  // Fold the gateway's job list once, by the naming rule the jobs were filed
  // under: a card looks its own bucket up rather than filtering the list here,
  // so one card's line can never carry another Bot's routines. The count is
  // gateway-side and never a run count.
  const routineHealth = useMemo(() => scorecardRoutineHealth(jobs), [jobs]);

  // Off until the stored flag says otherwise: D3's weekly report is opt-in and
  // a device that never asked holds no flag at all.
  const [weeklyReport, setWeeklyReport] = useState(false);
  // The refusal the last attempt met, or null. Only an attempt can set it, so
  // a device nobody ever asked never shows one.
  const [weeklyReportRefusal, setWeeklyReportRefusal] = useState<WeeklyReportRefusal | null>(null);
  /**
   * The operator's own answer outranks a read already in flight.
   *
   * Both writers of the one switch state paint from a promise, and whichever
   * lands last is what the operator sees — so a read captured before the tap
   * would resolve with the device as it was THEN and paint the pre-tap state
   * over the answer the attempt just gave. Every attempt bumps this token, and
   * a read captures it before its await: a read whose token is no longer
   * current paints nothing. Only the attempt bumps it, so a plain return to
   * this surface is never silenced by an old attempt.
   */
  const attemptTokenRef = useRef(0);

  // Paint both halves from one read of the device's state — the switch through
  // `weeklyReportOptInHolds`, the line under it through `weeklyReportRefusedBy`.
  // `readWeeklyReportOptIn` never rejects: a store it cannot read reads as off,
  // the fail-closed direction, and a permission it could not read is not
  // blamed. The read is the device's state, so a permission turned off in
  // Settings under a held flag opens on the module's own line rather than on a
  // switch quietly reading on.
  const refreshWeeklyReport = useCallback(() => {
    let live = true;
    const token = attemptTokenRef.current;
    void readWeeklyReportOptIn().then((state) => {
      if (!live || token !== attemptTokenRef.current) return;
      setWeeklyReport(weeklyReportOptInHolds(state));
      setWeeklyReportRefusal(weeklyReportRefusedBy(state));
    });
    return () => {
      live = false;
    };
  }, []);

  // Read on every return to this surface, by both routes the operator takes —
  // and both are needed. Focus catches a return to the tab (cron-section.tsx's
  // seam); a permission revoked in OS Settings is reached by LEAVING the app,
  // which backgrounds it rather than blurring the route, so the foreground edge
  // (index.tsx's AppState seam) is what catches that trip.
  useFocusEffect(refreshWeeklyReport);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshWeeklyReport();
    });
    return () => subscription.remove();
  }, [refreshWeeklyReport]);

  /**
   * The switch answers the finger, then the device has the last word: a
   * declined permission or a failed schedule leaves no opt-in behind, so the
   * control snaps back instead of promising a notice that is not there — and
   * the refusal it met is named below it rather than left looking like a
   * report nobody asked for.
   *
   * The token is bumped first, before the attempt awaits anything, so a read
   * already in flight is stale when it lands and cannot paint over this
   * answer. The attempt's own paint needs no guard: it is the newest word.
   */
  const handleWeeklyReport = (next: boolean) => {
    attemptTokenRef.current += 1;
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
            // The card's own state, not ListRow's `selected` — that one is the
            // backend picker's announced state and
            // `list-row-selected-state-test.ts` keeps that pass scoped to it.
            // One computation, used four times: the badge draws the module's
            // word for it, the card's sentence names it too, so an operator who
            // cannot see the badge is not told this card reads like every other
            // — and the hint and the chevron are decided from it, which is how
            // this one card ends up promising no list its tap cannot show, and
            // drawing no step towards one either.
            const showing = filter ? card.botId === filter.botId : false;
            // The card's line: the counts it folded, the share of them that
            // succeeded, and — when its own runs can back them — the median
            // span they ended on and the approval pressure they recorded. The
            // rows come through the fold's own
            // attribution rule, once, so one card's line can never borrow
            // another card's runs; each part is the module's own wording, and
            // the module composes the line — dropping a fact this card does not
            // hold, and dropping whole facts least-important-first when the one
            // line cannot hold them all. The routine verdict is the gateway's
            // own and keeps its own words, looked up by this card's bucket, and
            // the spend is P5's read merged onto this card — each keeps its own
            // words, and a card the spend read holds no row for says nothing
            // about spend rather than a zero.
            const rows = filterRunsByBot(runs, { botId: card.botId });
            const fates = scorecardFateCopy(card.fates);
            const success = scorecardSuccessCopy(scorecardSuccessRate(card.fates));
            const timed = scorecardDurationCopy(medianRunMs(rows));
            const approvals = scorecardApprovalCopy(scorecardApprovals(rows));
            const routines = scorecardRoutineCopy(routineHealth.get(card.botId));
            const spend = scorecardSpendCopy(card.spend);
            // One set of facts, two sentences: the module composes the line
            // this row DRAWS, to the room one clipped caption line has, and the
            // whole card this row ANNOUNCES — the row reads aloud the string it
            // draws, so a fact the budget dropped would be missing from what a
            // screen reader says as well. One object because they are the same
            // facts, so the two can never be composed from different ones. The
            // card's own state is handed to the announcement on top of them: the
            // badge draws it, and the sentence says it. The hint is the other
            // question — what the tap does next — and the module decides it from
            // the same `showing`, so the filtered card is handed none at all;
            // its chevron, the same promise drawn rather than spoken, comes off
            // that one state too.
            const facts = { fates, success, timed, approvals, routines, spend };
            return (
              <ListRow
                key={card.botId ?? 'unattributed'}
                title={scorecardBotLabel(card.botId)}
                subtitle={scorecardCardLine(facts)}
                accessibilityLabel={scorecardCardAnnouncement(scorecardBotLabel(card.botId), facts, showing)}
                onPress={() => onSelect({ botId: card.botId })}
                trailing={showing ? <Badge label={SCORECARD_SHOWING_LABEL} tone="accent" /> : undefined}
                chevron={scorecardCardChevron(showing)}
                accessibilityHint={scorecardCardHint(showing)}
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
