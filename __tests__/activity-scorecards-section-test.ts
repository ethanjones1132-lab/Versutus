// D3's Scorecards section on the Activity tab (FUTURE-ITEMS.md §D3 Build 3):
// one card per Bot, and tapping one filters the run list above to the runs it
// counted. The fold and the copy live in `@/lib/fleet/scorecard` (pinned in
// `fleet-scorecard-test.ts`); this suite pins the surface's wiring — that it
// renders the shipped copy rather than authoring its own, that it stays out of
// the way when this device holds no runs, and that the tab owns one filter
// state with a visible way back to the unfiltered list.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const section = () => readSource('src', 'components', 'activity', 'scorecards-section.tsx');
const tab = () => readSource('src', 'app', '(tabs)', 'activity.tsx');

describe('the section paints the shipped fold, and aggregates nothing itself', () => {
  test('every string on it comes from the module that decided it', () => {
    const src = section();

    expect(src).toContain("from '@/lib/fleet/scorecard'");
    expect(src).toContain('buildScorecards(runs)');
    expect(src).toContain('{scorecardBotLabel(card.botId)}');
    expect(src).toContain('const fates = scorecardFateCopy(card.fates);');
    expect(src).toContain('{scorecardWindowCopy(runs.length)}');
    expect(src).toContain('{SCORECARD_FOOTER_COPY}');
    // The card's own state is worded by the module too: the badge draws the
    // module's word for it, and the announcement appends the module's sentence.
    expect(src).toContain('SCORECARD_SHOWING_LABEL,');
  });

  test('the window line names the read the fold was handed, not the cards it produced', () => {
    const src = section();

    // A cap hit by rows that all folded into one card is still a capped read.
    expect(src).toContain('scorecardWindowCopy(runs.length)');
    expect(src).not.toContain('scorecardWindowCopy(cards.length)');
    expect(src).not.toContain('scorecardWindowCopy(cards)');
  });

  test('the card the list is filtered to says so, and no filter marks none', () => {
    const src = section();

    // The card's own state, not ListRow's `selected` — that one is the backend
    // picker's announced state and `list-row-selected-state-test.ts` keeps the
    // pass scoped to it.
    expect(src).toContain('const showing = filter ? card.botId === filter.botId : false;');
    // One state, one source of its word: the badge draws the module's word for
    // it (the visual is exactly what it was — a `Showing` badge on the card the
    // list is filtered to) and the announcement appends the module's sentence.
    expect(src).toContain(
      'trailing={showing ? <Badge label={SCORECARD_SHOWING_LABEL} tone="accent" /> : undefined}',
    );
    expect(src).not.toContain('label="Showing"');
    expect(src).not.toContain('selected=');
  });

  test('the section names no Bot this device has not seen run', () => {
    const src = section();

    // The cards come from the runs this device recorded and nothing else: no
    // roster read, no gateway request, so a Bot with no runs cannot appear.
    expect(src).not.toContain('listBots');
    expect(src).not.toContain('useGateway');
    expect(src).not.toContain('fetch(');
  });
});

describe('a card carries the run duration it can back', () => {
  test('the duration line is the module’s, timed over that card’s own rows', () => {
    const src = section();

    expect(src).toContain('scorecardDurationCopy(');
    expect(src).toContain('const rows = filterRunsByBot(runs, { botId: card.botId });');
    expect(src).toContain('medianRunMs(rows)');
    // One attribution rule in the file, and it is the fold's own — a card's
    // line can never be timed over another card's runs.
    expect(src.match(/filterRunsByBot\(/g)).toHaveLength(1);
    expect(src).not.toContain('runs.filter(');
  });

  test('a card that cannot back a duration shows its counts alone, never a zero', () => {
    const src = section();
    const fates = src.indexOf('const fates = scorecardFateCopy(card.fates);');
    const timed = src.indexOf('scorecardDurationCopy(');
    const subtitle = src.indexOf('subtitle={');

    expect(fates).toBeGreaterThanOrEqual(0);
    expect(timed).toBeGreaterThan(fates);
    expect(subtitle).toBeGreaterThan(timed);
    // Each part is the module's own wording and is handed to the module's own
    // composition, which is where a card's one line is decided: an empty fact
    // takes no room, and when the line cannot hold everything the fold drops
    // whole facts rather than clipping one (scorecardCardLine, pinned in
    // `fleet-scorecard-test.ts`). One `facts` object is handed to both folds —
    // the drawn line and the announcement — so the two strings cannot come
    // from two different sets of facts. Nothing is joined here.
    expect(src).toContain('const facts = { fates, success, timed, approvals, routines, spend };');
    expect(src).toContain('subtitle={scorecardCardLine(facts)}');
    expect(src.match(/scorecardCardLine\(/g)).toHaveLength(1);
    expect(src).not.toContain(".filter(Boolean).join(' · ')");
    expect(src).not.toContain('.join(');
  });
});

describe('a card the drawn line cannot hold in full is still announced in full', () => {
  test('the announcement is the module’s unbounded fold, over the same facts', () => {
    const src = section();

    // `ListRow` announces a row with the string it draws
    // (`src/components/ui/ListRow.tsx:74`), so a line composed to a budget
    // would drop the same facts from the sentence a screen reader reads. The
    // card hands the kit an announcement instead — the module's whole-card
    // fold, over the one `facts` object the drawn line is composed from, with
    // the card's own state as its third argument (pinned below).
    expect(src).toContain(
      'accessibilityLabel={scorecardCardAnnouncement(scorecardBotLabel(card.botId), facts, showing)}',
    );
    expect(src.match(/scorecardCardAnnouncement\(/g)).toHaveLength(1);
    // The name is the card's own title fold, not a second naming rule here.
    expect(src).not.toContain('accessibilityLabel={`');
  });

  test('the announcement rides the one card row, and the drawn line is untouched', () => {
    const src = section();
    const row = src.indexOf('<ListRow');
    const subtitle = src.indexOf('subtitle={scorecardCardLine(facts)}');
    const announcement = src.indexOf('accessibilityLabel={scorecardCardAnnouncement(');

    expect(src.match(/<ListRow/g)).toHaveLength(1);
    // Inside the one row the cards map produces, and after the string it draws:
    // the announcement supplements the row, it does not replace it.
    expect(announcement).toBeGreaterThan(row);
    expect(announcement).toBeGreaterThan(subtitle);
  });

  test('the announcement is handed the same showing the badge is drawn from', () => {
    const src = section();
    const showing = src.indexOf('const showing = filter ?');
    const announcement = src.indexOf('accessibilityLabel={scorecardCardAnnouncement(');
    const badge = src.indexOf('trailing={showing ?');

    // The state is computed once and used twice: the badge the operator sees and
    // the sentence a screen reader hears. It reaches the fold as that one
    // `showing` — never a literal that could disagree with the badge — and is
    // decided before the row that carries both.
    expect(src.match(/const showing = /g)).toHaveLength(1);
    expect(showing).toBeGreaterThanOrEqual(0);
    expect(announcement).toBeGreaterThan(showing);
    expect(badge).toBeGreaterThan(showing);
    expect(src).toMatch(/scorecardCardAnnouncement\([\s\S]*?facts, showing\)/);
    expect(src).not.toContain('facts, true)');
    expect(src).not.toContain('facts, false)');
  });
});

describe('a card promises only the tap it can deliver', () => {
  test('the hint is the module’s, decided off the same showing the state rides', () => {
    const src = section();

    // The hint answers a different question from the badge and the
    // announcement — what the TAP does — and on this one card the tap
    // re-applies the filter the list already carries
    // (`onPress={() => onSelect({ botId: card.botId })}`), so the shipped
    // promise is exactly what it cannot deliver. One expression, off the same
    // `showing`: the module decides which cards promise and which do not, and
    // this file words no hint of its own.
    expect(src).toContain('accessibilityHint={scorecardCardHint(showing)}');
    expect(src.match(/scorecardCardHint\(/g)).toHaveLength(1);
    expect(src).not.toContain('accessibilityHint="');
    expect(src).not.toContain('scorecardCardHint(true)');
    expect(src).not.toContain('scorecardCardHint(false)');
  });

  test('the hint is decided from the state, after the state is computed', () => {
    const src = section();
    const showing = src.indexOf('const showing = filter ?');
    const hint = src.indexOf('accessibilityHint={scorecardCardHint(showing)}');

    expect(showing).toBeGreaterThanOrEqual(0);
    expect(hint).toBeGreaterThan(showing);
    expect(src.match(/const showing = /g)).toHaveLength(1);
  });

  test('every other card keeps the shipped hint, character for character', () => {
    // The wording itself is the module's (pinned in `fleet-scorecard-test.ts`),
    // and a card that is not showing is handed it unchanged: this file holds no
    // hint string at all, so the two states cannot be worded apart.
    expect(section()).not.toContain("Shows this Bot's runs in the list above");
  });

  test('the chevron is the module’s too, decided off the same showing the hint and the badge ride', () => {
    const src = section();

    // The chevron is the kit's visual for "there is a surface this way", so on
    // this one card it draws a step the tap does not take — the drawn twin of
    // the missing hint, decided by the module off the same `showing`. One
    // expression, and this file hands the row no chevron literal of its own.
    expect(src).toContain('chevron={scorecardCardChevron(showing)}');
    expect(src.match(/scorecardCardChevron\(/g)).toHaveLength(1);
    expect(src).not.toContain('chevron={true}');
    expect(src).not.toContain('chevron={false}');
    expect(src).not.toContain('showChevron');
  });

  test('the chevron is decided from the state, after it, inside the one card row', () => {
    const src = section();
    const row = src.indexOf('<ListRow');
    const showing = src.indexOf('const showing = filter ?');
    const chevron = src.indexOf('chevron={scorecardCardChevron(showing)}');

    expect(showing).toBeGreaterThanOrEqual(0);
    expect(chevron).toBeGreaterThan(row);
    expect(chevron).toBeGreaterThan(showing);
    expect(src.match(/const showing = /g)).toHaveLength(1);
  });

  test('the badge, the announcement and the hint are exactly what they were beside it', () => {
    const src = section();

    // The chevron is taken away BESIDE the state's other riders, never at their
    // cost: the badge stays the visual it is, the announcement still appends
    // the state, and the hint expression is untouched.
    expect(src).toContain(
      'trailing={showing ? <Badge label={SCORECARD_SHOWING_LABEL} tone="accent" /> : undefined}',
    );
    expect(src).toContain(
      'accessibilityLabel={scorecardCardAnnouncement(scorecardBotLabel(card.botId), facts, showing)}',
    );
    expect(src).toContain('accessibilityHint={scorecardCardHint(showing)}');
  });
});

describe('a card states the success rate of the runs that reached a verdict', () => {
  test('the rate is the module’s, taken off the counts the card already folded', () => {
    const src = section();

    expect(src).toContain('scorecardSuccessCopy(scorecardSuccessRate(card.fates));');
    // The card's own counts decide it, never a second fold of the rows — so
    // the rate and the counts beside it cannot disagree.
    expect(src).not.toContain('scorecardSuccessRate(rows)');
  });

  test('the rate is decided after the counts it divides, before the line is composed', () => {
    const src = section();
    const fates = src.indexOf('const fates = scorecardFateCopy(card.fates);');
    const success = src.indexOf('const success = scorecardSuccessCopy(');
    const subtitle = src.indexOf('subtitle={');

    expect(success).toBeGreaterThan(fates);
    expect(subtitle).toBeGreaterThan(success);
  });
});

describe('a card carries its Bot’s routine health from the gateway’s cron list', () => {
  test('the routine line is the module’s, folded once and looked up by the card’s own bucket', () => {
    const src = section();

    expect(src).toContain('scorecardRoutineHealth(jobs)');
    expect(src).toContain('routineHealth.get(card.botId)');
    expect(src).toContain('scorecardRoutineCopy(');
    // The section still names no Bot of its own: the grouping rule is the
    // fold's, and the lookup is one key per card the runs already produced.
    expect(src).not.toContain('listBots');
    expect(src).not.toContain('useGateway');
    expect(src).not.toContain('runs.filter(');
  });

  test('the routine line is decided after the counts and before the line is composed', () => {
    const src = section();
    const fates = src.indexOf('const fates = scorecardFateCopy(card.fates);');
    const routines = src.indexOf('const routines = scorecardRoutineCopy(');
    const subtitle = src.indexOf('subtitle={');

    expect(routines).toBeGreaterThan(fates);
    expect(subtitle).toBeGreaterThan(routines);
  });
});

describe('a card carries the approval pressure its own rows recorded', () => {
  test('the approval line is the module’s, folded over that card’s own rows', () => {
    const src = section();

    expect(src).toContain('scorecardApprovalCopy(');
    expect(src).toContain('scorecardApprovals(rows)');
    // The same one attribution rule: the pressure is folded from the rows this
    // card counted, never from the whole read and never from a second rule.
    expect(src.match(/filterRunsByBot\(/g)).toHaveLength(1);
    expect(src).not.toContain('runs.filter(');
  });

  test('the approval line is decided after the counts and before the line is composed', () => {
    const src = section();
    const fates = src.indexOf('const fates = scorecardFateCopy(card.fates);');
    const approvals = src.indexOf('const approvals = scorecardApprovalCopy(');
    const subtitle = src.indexOf('subtitle={');

    expect(approvals).toBeGreaterThan(fates);
    expect(subtitle).toBeGreaterThan(approvals);
  });
});

describe('a card carries its Bot’s spend from P5’s read', () => {
  test('the spend line is the module’s, merged by the fold’s own id rule', () => {
    const src = section();

    // The rows are P5's read, handed in by the tab: this file performs no
    // gateway read of its own, and the merge rule stays in the fold.
    expect(src).toContain('withSpend(buildScorecards(runs), spendRows)');
    expect(src).toContain('scorecardSpendCopy(card.spend)');
    expect(src).not.toContain('listBots');
    expect(src).not.toContain('useGateway');
    expect(src).not.toContain('runs.filter(');
  });

  test('the spend line is decided after the routine line, before the line is composed', () => {
    const src = section();
    const routines = src.indexOf('const routines = scorecardRoutineCopy(');
    const spend = src.indexOf('const spend = scorecardSpendCopy(card.spend);');
    const subtitle = src.indexOf('subtitle={');

    expect(spend).toBeGreaterThan(routines);
    expect(subtitle).toBeGreaterThan(spend);
  });
});

describe('the section stays mounted when this device holds no runs', () => {
  test('no cards is no card, never a section that vanishes', () => {
    const src = section();
    const read = src.indexOf('const hasCards = cards.length > 0;');

    // The empty-device rule is about the CARDS. The section itself stays: the
    // weekly opt-in is reached from here (D3 Build 5), and a device that has
    // run nothing is exactly the device the report exists to bring back.
    expect(read).toBeGreaterThanOrEqual(0);
    expect(src).not.toContain('if (cards.length === 0) return null;');
  });

  test('the cards are all the empty read hides, and the opt-in renders past that branch', () => {
    const src = section();
    const branch = src.indexOf('{hasCards');
    const branchEnd = src.indexOf(': null}', branch);
    const cards = src.indexOf('cards.map(');
    const optIn = src.indexOf('{WEEKLY_REPORT_OPT_IN_LABEL}');

    expect(branch).toBeGreaterThanOrEqual(0);
    // An empty card would read as a Bot that fails at nothing, so the branch a
    // device with no runs takes renders nothing at all.
    expect(branchEnd).toBeGreaterThan(branch);
    expect(cards).toBeGreaterThan(branch);
    // The one control a device with no runs still needs renders after that
    // branch has closed, so it cannot be hidden along with the cards.
    expect(optIn).toBeGreaterThan(branchEnd);
  });

  test('the window line names the empty read too, so it sits outside the card branch', () => {
    const src = section();
    const window = src.indexOf('{scorecardWindowCopy(runs.length)}');
    const branch = src.indexOf('{hasCards');

    expect(window).toBeGreaterThanOrEqual(0);
    expect(window).toBeLessThan(branch);
  });

  test('the only card in the file is inside the fold, so an empty read names no Bot', () => {
    const src = section();
    const row = src.indexOf('<ListRow');
    const cards = src.indexOf('cards.map(');

    expect(src.match(/<ListRow/g)).toHaveLength(1);
    expect(row).toBeGreaterThan(cards);
  });

  test('the guard on the cards is decided before any card is rendered', () => {
    const src = section();
    const guard = src.indexOf('const hasCards = cards.length > 0;');
    const cards = src.indexOf('cards.map(');

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(cards).toBeGreaterThan(guard);
  });
});

describe('a tapped card filters the runs it counted, with a way back', () => {
  test('the tap hands the tab that card, unattributed bucket included', () => {
    const src = section();

    // `card.botId` is null for the unattributed card, so tapping it asks for
    // that bucket rather than for "every run".
    expect(src).toContain('onPress={() => onSelect({ botId: card.botId })}');
  });

  test('the way back to the unfiltered list is a control, and only while filtering', () => {
    const src = section();
    const guard = src.indexOf('{filter ? (');
    const clear = src.indexOf('onSelect(null)');

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(clear).toBeGreaterThan(guard);
    expect(src.match(/onSelect\(null\)/g)).toHaveLength(1);
  });
});

describe('the Activity tab owns one filter state over the provider’s runs', () => {
  test('no filter is the default, so the tab opens exactly as it did before', () => {
    expect(tab()).toContain('useState<ScorecardFilter>(null)');
  });

  test('the visible list is the provider’s list through the shipped pure filter', () => {
    const src = tab();

    expect(src).toContain('filterRunsByBot(activityRuns, scorecardFilter)');
    expect(src).toContain("from '@/lib/fleet/scorecard'");
  });

  test('the section folds the provider’s runs, never the filtered view', () => {
    const src = tab();

    // Folding the filtered list would shrink the cards to the very selection
    // they produced, and the operator could never switch cards again.
    expect(src).toContain('<ScorecardsSection runs={activityRuns}');
    expect(src).not.toContain('runs={visibleRuns}');
  });
});

describe('a run notice’s tap drops a stale Bot filter', () => {
  test('the tab consumes the run focus the provider was handed', () => {
    const src = tab();

    expect(src).toContain('requestedRunFocus');
    expect(src).toContain('clearRequestedRunFocus');
  });

  test('applying the request drops the filter, deferred, and retires the request with it', () => {
    const src = tab();
    const guard = src.indexOf('if (!requestedRunFocus) return undefined;');
    const drop = src.indexOf('setScorecardFilter(null)');
    const clear = src.indexOf('clearRequestedRunFocus()');

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThan(guard);
    expect(clear).toBeGreaterThan(drop);
    // Deferred a tick, like every other producer of state from an effect in
    // this repo — and the request is cleared with the filter, so it can never
    // fight the operator's own next navigation.
    expect(src.slice(guard, clear)).toContain('setTimeout(');
  });

  test('the named run is not selected — a row this read cannot prove is not shown', () => {
    const src = tab();
    const guard = src.indexOf('if (!requestedRunFocus) return undefined;');
    const clear = src.indexOf('clearRequestedRunFocus()');
    const body = src.slice(guard, clear);

    // The id on the request makes two taps the same tap; the tab drops the
    // filter and never narrows the list to a run the read may not hold.
    expect(body).toContain('setScorecardFilter(null)');
    expect(body).not.toContain('runId');
    expect(body).not.toContain('setOpenAgenticRunId');
  });

  test('the unfiltered default is untouched', () => {
    expect(tab()).toContain('useState<ScorecardFilter>(null)');
  });
});

describe('the section sits in the Activity footer, above the scheduled work', () => {
  test('footer, then the cards, then CronSection', () => {
    const src = tab();
    const footer = src.indexOf('const listFooter = (');
    const cards = src.indexOf('<ScorecardsSection');
    const cron = src.indexOf('<CronSection');

    expect(footer).toBeGreaterThanOrEqual(0);
    expect(cards).toBeGreaterThan(footer);
    expect(cron).toBeGreaterThan(cards);
  });
});

describe('the tab reads the gateway’s jobs, so a card can carry its Bot’s routine health', () => {
  test('the section is handed the jobs beside the runs it already folded', () => {
    const src = tab();

    expect(src).toContain('<ScorecardsSection runs={activityRuns} jobs={routineJobs}');
  });

  test('the read is the gateway’s own job list, and a gateway that cannot answer claims nothing', () => {
    const src = tab();

    expect(src).toContain('cron.list()');
    expect(src).toContain('cron.available');
    // The same two edges CronSection hangs its own re-list off, so a routine
    // that fails while Activity is backgrounded is caught on the way back in.
    expect(src).toContain('useFocusEffect(loadRoutineJobs)');
    expect(src).toContain('cronReloadSignal');
  });
});

describe('the tab reads P5’s per-Bot spend, so a card can carry what its Bot cost', () => {
  test('the section is handed the spend beside the runs and the jobs', () => {
    const src = tab();

    expect(src).toContain(
      '<ScorecardsSection runs={activityRuns} jobs={routineJobs} spendRows={spendRows}',
    );
  });

  test('the read is P5’s own, and a gateway that cannot be asked is never asked', () => {
    const src = tab();

    // The Spend screen's own read, so a card and that screen word one read the
    // same way — and the scoped read joins the source only where the client
    // advertises it.
    expect(src).toContain('readBotSpend(');
    expect(src).toContain('canReadBotSessions ? { listBots, readBotSessions } : { listBots }');
    expect(src).toContain('useFocusEffect(loadBotSpend)');
    expect(src).toContain('cronReloadSignal');
  });

  test('a read that fails leaves no rows, so no card claims a spend nobody read', () => {
    const src = tab();

    expect(src).toContain('status === \'connected\'');
    expect(src).toContain('.catch(() => [] as BotSpendRow[])');
    expect(src).toContain('useState<BotSpendRow[]>([])');
  });
});

describe('what must keep working', () => {
  test('with no filter the run sections, their order and their labels are unchanged', () => {
    const src = tab();

    expect(src).toContain("items.push({ kind: 'label', id: 'in-flight', text: 'In flight' });");
    expect(src).toContain("items.push({ kind: 'label', id: 'recent', text: 'Recent runs' });");
    expect(src.indexOf("text: 'In flight'")).toBeLessThan(src.indexOf("text: 'Recent runs'"));
  });

  test('every RunCard affordance and the empty state are still the shipped ones', () => {
    const src = tab();

    expect(src).toContain('<RunCard run={item.run} onStop={stopActivityRun} />');
    expect(src).toContain('onOpenTranscript={setOpenAgenticRunId}');
    expect(src).toContain('onRetry={(prompt) => retryRun({ ...item.run, prompt })}');
    expect(src).toContain('activityRuns.length === 0 && !pendingRunApproval');
  });

  test('the footer still carries the scheduled work and the spend entry', () => {
    const src = tab();

    expect(src).toContain('<CronSection cronReloadSignal={cronReloadSignal} />');
    expect(src).toContain('<SpendEntryRow />');
  });
});

describe('the weekly operator report is opted into here, off by default', () => {
  test('the opt-in says what the module decided, not what this file invents', () => {
    const src = section();

    expect(src).toContain("from '@/lib/notifications/weekly-report-schedule'");
    expect(src).toContain('{WEEKLY_REPORT_OPT_IN_LABEL}');
    expect(src).toContain('{WEEKLY_REPORT_OPT_IN_SUMMARY}');
    // The notice's own words — including the title a tray shows — are the
    // module's, so nothing about the report is re-authored on the surface.
    expect(src).not.toContain('Your weekly agent report');
  });

  test('the switch shows the stored flag, and a declined opt-in snaps it back', () => {
    const src = section();

    // Off until the device's own state says otherwise — and that state is the
    // permission-aware read, never the stored flag alone: a flag whose
    // permission the phone has since revoked must not paint on.
    expect(src).toContain('useState(false)');
    expect(src).toContain('readWeeklyReportOptIn()');
    expect(src).not.toContain('loadWeeklyReportOptIn()');
    // The state this device holds after the attempt is what the switch paints,
    // so it can never show "on" for a notice that is not scheduled.
    expect(src).toContain('setWeeklyReportOptIn(next).then((state) => {');
    expect(src).toContain('setWeeklyReport(weeklyReportOptInHolds(state));');
    expect(src).toContain('setWeeklyReportRefusal(weeklyReportRefusedBy(state));');
  });

  test('the read paints the state this device holds, a refusal included', () => {
    const src = section();
    const read = src.indexOf('readWeeklyReportOptIn()');
    const holds = src.indexOf('setWeeklyReport(weeklyReportOptInHolds(state));');
    const refusal = src.indexOf('setWeeklyReportRefusal(weeklyReportRefusedBy(state));');

    // The read answers both halves: the switch, and the line under it — so an
    // opt-in the phone stopped allowing opens on an explained refusal rather
    // than on a switch quietly reading off.
    expect(read).toBeGreaterThanOrEqual(0);
    expect(holds).toBeGreaterThan(read);
    expect(refusal).toBeGreaterThan(read);
  });

  test('the read is taken on every return to the surface, never only at mount', () => {
    const src = section();
    const refresh = src.indexOf('const refreshWeeklyReport = useCallback(');
    const read = src.indexOf('readWeeklyReportOptIn()');
    const focus = src.indexOf('useFocusEffect(refreshWeeklyReport)');
    const foreground = src.indexOf("AppState.addEventListener('change'");

    // A tab screen keeps its children mounted for the life of the app, so mount
    // is never the edge that catches a revocation the app lived through: the
    // read hangs off the returns themselves. Both of the repo's returns are
    // needed — focus for a return to the tab (cron-section.tsx), and the
    // foreground edge for a trip to OS Settings, which backgrounds the app
    // without blurring the route (index.tsx).
    expect(src).toMatch(/import \{ useFocusEffect \} from 'expo-router';/);
    expect(refresh).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(refresh);
    expect(focus).toBeGreaterThan(refresh);
    expect(foreground).toBeGreaterThan(refresh);
    // One call site, inside the one refresh the two returns share, so neither
    // edge can drift into reading a state the other never paints.
    expect(src.match(/readWeeklyReportOptIn\(\)/g)).toHaveLength(1);
    // The foreground arm reads on the way back only, never as the app leaves.
    expect(src).toMatch(/state === 'active'\) refreshWeeklyReport\(\)/);
  });

  test('a refused opt-in says why, in the module copy, under the switch', () => {
    const src = section();

    // The line is decided from the refusal the attempt answered with — never
    // from "the switch is off", which a device that never asked also is.
    expect(src).toContain('useState<WeeklyReportRefusal | null>(null)');
    expect(src).toContain('{weeklyReportRefusal ? (');
    expect(src).toContain('{weeklyReportRefusalCopy(weeklyReportRefusal)}');
    // Cleared with every attempt, so a stale refusal cannot outlive the try
    // that met it.
    expect(src).toContain('setWeeklyReportRefusal(null);');
    // The words are the module's, never this file's.
    expect(src).not.toContain('Notifications are off for Versutus');
    expect(src).not.toContain('could not be scheduled just now');

    const optIn = src.indexOf('{WEEKLY_REPORT_OPT_IN_LABEL}');
    const refusal = src.indexOf('{weeklyReportRefusalCopy(');
    const footer = src.indexOf('{SCORECARD_FOOTER_COPY}');
    expect(refusal).toBeGreaterThan(optIn);
    expect(footer).toBeGreaterThan(refusal);
  });

  test('the surface asks for the notice and schedules nothing itself', () => {
    const src = section();

    // Scheduling and its bookkeeping live in the notifications module, which
    // is where the honesty rules are pinned. Nothing here touches the API.
    expect(src).not.toContain('scheduleNotificationAsync');
    expect(src).not.toContain('cancelScheduledNotificationAsync');
    expect(src).not.toContain("from 'expo-notifications'");
    expect(src).not.toContain('expo-notifications');
  });

  test('the opt-in sits inside the card, above the footer sentence that closes it', () => {
    const src = section();
    const optIn = src.indexOf('{WEEKLY_REPORT_OPT_IN_LABEL}');
    const footer = src.indexOf('{SCORECARD_FOOTER_COPY}');
    const close = src.indexOf('</Card>');

    expect(optIn).toBeGreaterThanOrEqual(0);
    expect(footer).toBeGreaterThan(optIn);
    expect(close).toBeGreaterThan(footer);
  });
});

describe('a card’s spend is stated beside the bound it was read at', () => {
  test('the cap line is P5’s own copy at the real limit, not re-authored here', () => {
    const src = section();

    // The per-Bot reads stopped at their own cap, and the Spend screen names it
    // under its rows with `botSpendCapCopy`. One bound, one wording: this
    // surface prints the module's string at the module's constant, so the two
    // surfaces cannot describe one read two ways and no number here is retyped.
    expect(src).toContain("from '@/lib/gateway/session-analytics'");
    expect(src).toContain('botSpendCapCopy(SESSION_SPEND_LIST_LIMIT)');
    expect(src.match(/botSpendCapCopy\(/g)).toHaveLength(1);
    expect(src).not.toContain('newest 200 sessions');
  });

  test('the cap line renders once, outside the card branch', () => {
    const src = section();
    const cap = src.indexOf('{botSpendCapCopy(SESSION_SPEND_LIST_LIMIT)}');
    const branch = src.indexOf('{hasCards');

    // Outside the branch because the bound is the READ's, not one card's: a
    // capped read understates every card under it.
    expect(cap).toBeGreaterThanOrEqual(0);
    expect(cap).toBeLessThan(branch);
    // And the card's own line is untouched — still exactly `botSpendRowCopy`'s
    // words through `scorecardSpendCopy`, with no cap written onto a card.
    expect(src).toContain('scorecardSpendCopy(card.spend)');
  });

  test('a read that left every card without spend shows nothing', () => {
    const src = section();
    const guard = src.indexOf('{cardsCarrySpend ? (');
    const cap = src.indexOf('{botSpendCapCopy(SESSION_SPEND_LIST_LIMIT)}');

    // One predicate decides it, and it is the fold's own over the merged cards:
    // a device whose read priced no Bot it has runs for never names a cap it
    // did not hit, and this surface decides that nowhere itself.
    expect(src).toContain('const cardsCarrySpend = scorecardsCarrySpend(cards);');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(cap).toBeGreaterThan(guard);
    expect(src).not.toContain('cards.some(');
    expect(src).not.toContain('spendRows.some(');
  });

  test('the run window is still the run read’s, and the cap did not replace it', () => {
    const src = section();
    const window = src.indexOf('{scorecardWindowCopy(runs.length)}');
    const cap = src.indexOf('{botSpendCapCopy(SESSION_SPEND_LIST_LIMIT)}');

    // Two bounds, two reads: the window line stays the runs this device holds,
    // the cap line names the spend read's own limit, and the cap sits under the
    // window rather than standing in for it.
    expect(window).toBeGreaterThanOrEqual(0);
    expect(window).toBeLessThan(cap);
    expect(src.match(/scorecardWindowCopy\(/g)).toHaveLength(1);
  });
});

describe('the operator’s own answer outranks a read already in flight', () => {
  test('the read captures the token as it starts, before the await', () => {
    const src = section();
    const refresh = src.indexOf('const refreshWeeklyReport = useCallback(');
    const capture = src.indexOf('const token = attemptTokenRef.current;');
    const read = src.indexOf('readWeeklyReportOptIn()');
    const guard = src.indexOf('if (!live || token !== attemptTokenRef.current) return;');

    expect(src).toContain('const attemptTokenRef = useRef(0);');
    expect(capture).toBeGreaterThan(refresh);
    // Captured BEFORE the read is taken, so the token names the moment it
    // started rather than the moment its answer landed — which is the whole
    // point: a read that outlives the attempt is the one to drop.
    expect(capture).toBeLessThan(read);
    expect(guard).toBeGreaterThan(read);
  });

  test('the attempt is the only writer that bumps it, and its answer stays unguarded', () => {
    const src = section();
    const handler = src.indexOf('const handleWeeklyReport = (next: boolean) => {');
    const bump = src.indexOf('attemptTokenRef.current += 1;');
    const tap = src.indexOf('setWeeklyReport(next);');
    const attempt = src.indexOf('setWeeklyReportOptIn(next).then((state) => {');
    const attemptBody = src.slice(attempt, src.indexOf('});', attempt));

    // Bumped as the attempt starts, before it awaits anything on the native
    // bridge, so a read captured earlier is stale by the time it lands.
    expect(bump).toBeGreaterThan(handler);
    expect(bump).toBeLessThan(tap);
    // Exactly one bump, and it is the attempt's: a read that bumped it would
    // silence the very returns to this surface it exists to catch.
    expect(src.match(/attemptTokenRef\.current \+= 1;/g)).toHaveLength(1);
    // The attempt needs no token of its own — the operator's own tap is the
    // newest word, so its paint is the unguarded one.
    expect(src.match(/!== attemptTokenRef\.current/g)).toHaveLength(1);
    expect(attemptBody).not.toContain('attemptTokenRef');
  });
});
