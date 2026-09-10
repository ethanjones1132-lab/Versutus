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

describe('the section stays out of the way when this device holds no runs', () => {
  test('no cards is no section, never a placeholder', () => {
    expect(section()).toContain('if (cards.length === 0) return null;');
  });

  test('the guard runs before any card is rendered', () => {
    const src = section();
    const guard = src.indexOf('if (cards.length === 0) return null;');
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
