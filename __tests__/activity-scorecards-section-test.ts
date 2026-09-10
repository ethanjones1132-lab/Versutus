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
    expect(src).toContain('{scorecardFateCopy(card.fates)}');
    expect(src).toContain('{scorecardWindowCopy(runs.length)}');
    expect(src).toContain('{SCORECARD_FOOTER_COPY}');
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
    expect(src).toContain('trailing={showing ? <Badge label="Showing" tone="accent" /> : undefined}');
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
