// The scorecard fold: the run rows this device persisted, gathered into one
// card per Bot (FUTURE-ITEMS.md §D3 Build 1). A card is a claim about a Bot's
// track record, so the ways a count can lie are pinned here: a cancelled run is
// not a failure (D3:803-804), a row that names no Bot is neither dropped nor
// guessed into someone else's card (D3:792-797), and the window the fold was
// handed is named rather than read as a gateway-side total (D3:808-810, :824-828).

// The window line names the real cap, so this suite reads the constant off the
// persistence module — which reaches storage only to declare itself. Nothing
// here reads or writes a key.
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
}));

import {
  buildScorecards,
  filterRunsByBot,
  medianRunMs,
  scorecardBotLabel,
  scorecardDurationCopy,
  scorecardFate,
  scorecardFateCopy,
  scorecardWindowCopy,
  SCORECARD_FOOTER_COPY,
} from '@/lib/fleet/scorecard';
import type { BotScorecard, ScorecardFates } from '@/lib/fleet/scorecard';
import { ACTIVITY_RUNS_PERSIST_CAP, normalizeRestoredRuns } from '@/lib/gateway/session-persistence';
import type { ActivityRun } from '@/lib/gateway/runs';

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

/**
 * A row, unattributed unless a case names a Bot — the shape of every row
 * persisted before the field existed.
 */
function run(overrides: Partial<ActivityRun> = {}): ActivityRun {
  return {
    id: 'run-1',
    prompt: 'do the thing',
    status: 'complete',
    startedAt: 1_757_400_000_000,
    finishedAt: 1_757_400_060_000,
    events: [],
    ...overrides,
  };
}

/** The card for one Bot; `null` is the unattributed bucket. */
function cardFor(cards: BotScorecard[], botId: string | null): BotScorecard {
  const card = cards.find((candidate) => candidate.botId === botId);
  if (!card) throw new Error(`no card for ${String(botId)}`);
  return card;
}

describe('buildScorecards', () => {
  test('counts the four settled fates apart', () => {
    const cards = buildScorecards([
      run({ id: 'a', botId: 'atlas', status: 'complete' }),
      run({ id: 'b', botId: 'atlas', status: 'failed' }),
      run({ id: 'c', botId: 'atlas', status: 'cancelled' }),
      run({ id: 'd', botId: 'atlas', status: 'unresolved' }),
    ]);

    expect(cards).toHaveLength(1);
    expect(cardFor(cards, 'atlas')).toEqual({
      botId: 'atlas',
      total: 4,
      fates: { complete: 1, failed: 1, cancelled: 1, unresolved: 1, inFlight: 0 },
    });
  });

  test('a cancelled run is not a failure', () => {
    const card = cardFor(
      buildScorecards([
        run({ id: 'ok', botId: 'atlas', status: 'complete' }),
        run({ id: 'stopped', botId: 'atlas', status: 'cancelled' }),
      ]),
      'atlas',
    );

    // The operator stopped it; nothing failed and nothing succeeded either.
    expect(card.fates.failed).toBe(0);
    expect(card.fates.cancelled).toBe(1);
    expect(card.fates.complete).toBe(1);
  });

  test('keeps one card per Bot, each counting only its own runs', () => {
    const cards = buildScorecards([
      run({ id: 'a', botId: 'atlas', status: 'complete' }),
      run({ id: 'b', botId: 'bramble', status: 'failed' }),
      run({ id: 'c', botId: 'atlas', status: 'complete' }),
    ]);

    expect(cards).toHaveLength(2);
    expect(cardFor(cards, 'atlas').fates).toEqual({
      complete: 2,
      failed: 0,
      cancelled: 0,
      unresolved: 0,
      inFlight: 0,
    });
    expect(cardFor(cards, 'bramble').total).toBe(1);
  });

  test('holds the rows that name no Bot in one unattributed bucket', () => {
    const cards = buildScorecards([
      run({ id: 'legacy', status: 'complete' }),
      run({ id: 'configurable', status: 'failed' }),
      run({ id: 'atlas-run', botId: 'atlas', status: 'complete' }),
    ]);

    expect(cards).toHaveLength(2);
    expect(cardFor(cards, null).total).toBe(2);
    // Never guessed into a Bot: atlas's card is exactly its own row.
    expect(cardFor(cards, 'atlas').total).toBe(1);
    expect(cardFor(cards, 'atlas').fates.failed).toBe(0);
  });

  test('an id that is present but empty is not a Bot', () => {
    const cards = buildScorecards([run({ botId: '' })]);

    expect(cards).toHaveLength(1);
    expect(cards[0].botId).toBeNull();
    expect(cards[0].total).toBe(1);
  });

  test('a run still going counts where it is, never as a settled fate', () => {
    const card = cardFor(
      buildScorecards([
        run({ id: 'going', botId: 'atlas', status: 'running', finishedAt: undefined }),
        run({ id: 'stuck', botId: 'atlas', status: 'waiting-approval', finishedAt: undefined }),
      ]),
      'atlas',
    );

    expect(card.fates.inFlight).toBe(2);
    expect(card.fates.complete + card.fates.failed + card.fates.cancelled + card.fates.unresolved).toBe(0);
  });

  test('every row in the list lands in exactly one bucket', () => {
    const runs = [
      run({ id: 'a', botId: 'atlas', status: 'complete' }),
      run({ id: 'b', botId: 'atlas', status: 'failed' }),
      run({ id: 'c', botId: 'bramble', status: 'cancelled' }),
      run({ id: 'd', botId: 'bramble', status: 'unresolved' }),
      run({ id: 'e', botId: 'bramble', status: 'running', finishedAt: undefined }),
      run({ id: 'f', status: 'waiting-approval', finishedAt: undefined }),
      run({ id: 'g', status: 'failed' }),
    ];
    const cards = buildScorecards(runs);

    expect(cards.reduce((sum, card) => sum + card.total, 0)).toBe(runs.length);
    for (const card of cards) {
      const { complete, failed, cancelled, unresolved, inFlight } = card.fates;
      expect(complete + failed + cancelled + unresolved + inFlight).toBe(card.total);
    }
  });

  test('cards follow the run list, so the most recent Bot comes first', () => {
    const cards = buildScorecards([
      run({ id: 'a', botId: 'bramble' }),
      run({ id: 'b', botId: 'atlas' }),
      run({ id: 'c', botId: 'bramble' }),
    ]);

    expect(cards.map((card) => card.botId)).toEqual(['bramble', 'atlas']);
  });

  test('a Bot with no runs gets no card — the fold cannot invent one', () => {
    expect(buildScorecards([])).toEqual([]);
  });
});

describe('scorecardFate', () => {
  test('names the one bucket a status belongs to', () => {
    expect(scorecardFate('complete')).toBe('complete');
    expect(scorecardFate('failed')).toBe('failed');
    expect(scorecardFate('cancelled')).toBe('cancelled');
    expect(scorecardFate('unresolved')).toBe('unresolved');
    expect(scorecardFate('running')).toBe('inFlight');
    expect(scorecardFate('waiting-approval')).toBe('inFlight');
  });
});

describe('scorecardWindowCopy', () => {
  test('a fold that filled the persisted cap names the cap', () => {
    const copy = scorecardWindowCopy(ACTIVITY_RUNS_PERSIST_CAP);

    expect(copy).toContain(String(ACTIVITY_RUNS_PERSIST_CAP));
    expect(copy).toContain("past the list's cap");
  });

  test('a count over the cap still names the cap, never the larger number', () => {
    const over = ACTIVITY_RUNS_PERSIST_CAP + 5;
    const copy = scorecardWindowCopy(over);

    expect(copy).toContain(String(ACTIVITY_RUNS_PERSIST_CAP));
    expect(copy).not.toContain(String(over));
  });

  test('the last row under the cap is the read, and claims no bound it did not hit', () => {
    const copy = scorecardWindowCopy(ACTIVITY_RUNS_PERSIST_CAP - 1);

    expect(copy).toBe(`${ACTIVITY_RUNS_PERSIST_CAP - 1} runs in this read`);
    expect(copy).not.toContain('cap');
  });

  test('a handful of runs is named exactly as it was handed over', () => {
    expect(scorecardWindowCopy(7)).toBe('7 runs in this read');
    expect(scorecardWindowCopy(1)).toBe('1 run in this read');
  });

  test('a count it cannot read prints no NaN and no settled bound', () => {
    expect(scorecardWindowCopy(Number.NaN)).toBe('0 runs in this read');
    expect(scorecardWindowCopy(Number.POSITIVE_INFINITY)).toBe('0 runs in this read');
  });

  test('no window line claims a gateway-side total', () => {
    for (const count of [0, 7, ACTIVITY_RUNS_PERSIST_CAP - 1, ACTIVITY_RUNS_PERSIST_CAP]) {
      expect(scorecardWindowCopy(count)).not.toMatch(/gateway|total|every run|all runs/i);
    }
  });
});

describe('SCORECARD_FOOTER_COPY', () => {
  test('says these cards are runs this device saw', () => {
    expect(SCORECARD_FOOTER_COPY).toContain('Runs seen from this device');
  });

  test('carries no number, so it can never be read as a count', () => {
    expect(SCORECARD_FOOTER_COPY).not.toMatch(/[0-9]/);
    expect(SCORECARD_FOOTER_COPY).not.toMatch(/gateway|total/i);
  });

  test('a card is numbers only, so the sentence cannot ride on one', () => {
    const cards = buildScorecards([
      run({ id: 'a', botId: 'atlas', status: 'complete' }),
      run({ id: 'b', status: 'failed' }),
    ]);

    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(Object.keys(card).sort()).toEqual(['botId', 'fates', 'total']);
      expect(JSON.stringify(card)).not.toContain('seen from this device');
    }
  });

  test('the module holds the sentence exactly once, for the one footer', () => {
    const source = readSource('src', 'lib', 'fleet', 'scorecard.ts');

    expect(source.split(SCORECARD_FOOTER_COPY)).toHaveLength(2);
  });
});

describe('filterRunsByBot', () => {
  test('no filter passes the list through unchanged', () => {
    const runs = [run({ id: 'a', botId: 'atlas' }), run({ id: 'b' })];

    // Not merely the same rows: the tab's unfiltered read, untouched.
    expect(filterRunsByBot(runs, null)).toBe(runs);
  });

  test("a Bot's card keeps only that Bot's rows, in the order they were read", () => {
    const runs = [
      run({ id: 'a', botId: 'atlas' }),
      run({ id: 'b', botId: 'bramble' }),
      run({ id: 'c', botId: 'atlas' }),
    ];

    expect(filterRunsByBot(runs, { botId: 'atlas' }).map((entry) => entry.id)).toEqual(['a', 'c']);
  });

  test('the unattributed card is its own selection, and keeps the rows that name no Bot', () => {
    const runs = [
      run({ id: 'legacy' }),
      run({ id: 'empty', botId: '' }),
      run({ id: 'atlas-run', botId: 'atlas' }),
    ];

    // A half-shaped id is not a Bot, so it is unattributed too — the same rule
    // the fold buckets by.
    expect(filterRunsByBot(runs, { botId: null }).map((entry) => entry.id)).toEqual(['legacy', 'empty']);
  });

  test('a card for a Bot this read holds no rows for is empty, never someone else’s rows', () => {
    const runs = [run({ id: 'a', botId: 'atlas' })];

    expect(filterRunsByBot(runs, { botId: 'bramble' })).toEqual([]);
  });
});

describe('scorecardBotLabel', () => {
  test('a card is titled with the Bot it counts', () => {
    expect(scorecardBotLabel('atlas')).toBe('atlas');
  });

  test('the rows that name no Bot get one heading, not a Bot named after them', () => {
    const label = scorecardBotLabel(null);

    expect(label).toBe('Unattributed');
    expect(label).not.toBe('');
  });
});

describe('scorecardFateCopy', () => {
  const fates = (over: Partial<ScorecardFates>): ScorecardFates => ({
    complete: 0,
    failed: 0,
    cancelled: 0,
    unresolved: 0,
    inFlight: 0,
    ...over,
  });

  test('lists the counts the card holds, in the fold’s own order', () => {
    const copy = scorecardFateCopy(
      fates({ complete: 3, failed: 1, cancelled: 2, unresolved: 1, inFlight: 1 }),
    );

    expect(copy).toBe('3 complete · 1 failed · 2 cancelled · 1 unresolved · 1 in flight');
  });

  test('a fate with no runs is not printed as a zero', () => {
    expect(scorecardFateCopy(fates({ complete: 4 }))).toBe('4 complete');
  });

  test('a cancelled run reads as cancelled, never folded into a failure', () => {
    const copy = scorecardFateCopy(fates({ cancelled: 2 }));

    expect(copy).toBe('2 cancelled');
    expect(copy).not.toContain('failed');
  });

  test('a run still going reads as in flight, not as a settled fate', () => {
    expect(scorecardFateCopy(fates({ inFlight: 2 }))).toBe('2 in flight');
  });

  test('nothing at all prints nothing, never a zero', () => {
    expect(scorecardFateCopy(fates({}))).toBe('');
  });
});

describe('medianRunMs', () => {
  const NOW = 1_757_400_000_000;

  /** A row that ended `ms` before NOW — one span this device watched end. */
  const endedIn = (ms: number, over: Partial<ActivityRun> = {}): ActivityRun =>
    run({ startedAt: NOW - ms, finishedAt: NOW, ...over });

  test('the middle span of an odd count of runs', () => {
    expect(medianRunMs([endedIn(20_000), endedIn(30_000), endedIn(50_000)], NOW)).toBe(30_000);
  });

  test('an even count answers with the midpoint of its two middle spans', () => {
    const spans = [endedIn(80_000), endedIn(10_000), endedIn(40_000), endedIn(20_000)];

    expect(medianRunMs(spans, NOW)).toBe(30_000);
  });

  test('only the rows this device watched end are timed', () => {
    const rows = [
      endedIn(30_000, { id: 'ok' }),
      run({ id: 'going', status: 'running', startedAt: NOW - 900_000, finishedAt: undefined }),
      run({ id: 'stuck', status: 'waiting-approval', startedAt: NOW - 900_000, finishedAt: undefined }),
    ];

    // The two live rows are still on the card's counts; they are not time.
    expect(medianRunMs(rows, NOW)).toBe(30_000);
  });

  test('an unresolved run contributes no duration — its finish is when this device stopped watching', () => {
    const stopped = endedIn(900_000, { id: 'unresolved', status: 'unresolved' });

    // The run may still have been going server-side when this client gave up
    // (runs.ts:25-30), so its span is a lower bound dressed up as a run time.
    expect(medianRunMs([endedIn(30_000, { id: 'ok' }), stopped], NOW)).toBe(30_000);
    expect(medianRunMs([stopped], NOW)).toBeNull();
  });

  test('the row the app interrupted on load contributes no time-to-app-close', () => {
    const restored = normalizeRestoredRuns([
      run({ id: 'killed', status: 'running', startedAt: NOW - 900_000, finishedAt: undefined }),
    ]);

    // A kill re-marks the row on the next load and stamps `finishedAt` with the
    // moment it reads it, so the span that falls out is how long the app was
    // CLOSED — never how long the run took.
    expect(restored[0].status).toBe('unresolved');
    expect(medianRunMs(restored)).toBeNull();
  });

  test('a finish past the fold’s own clock is not a duration this device reached', () => {
    // An unsettled record may carry a placeholder, and the fold never reads one
    // as an end (the rule `buildHomeBriefing` applies, briefing.ts:47-49).
    expect(medianRunMs([endedIn(60_000, { finishedAt: NOW + 5_000 })], NOW)).toBeNull();
  });

  test('a span that is not positive is not a run time', () => {
    expect(medianRunMs([endedIn(0)], NOW)).toBeNull();
    expect(
      medianRunMs(
        [run({ id: 'skew', status: 'complete', startedAt: NOW, finishedAt: NOW - 5_000 })],
        NOW,
      ),
    ).toBeNull();
  });

  test('a card with nothing it can time says nothing rather than 0', () => {
    expect(medianRunMs([], NOW)).toBeNull();
    expect(medianRunMs([run({ id: 'going', status: 'running', finishedAt: undefined })], NOW)).toBeNull();
  });

  test('a card is timed over its own rows, by the fold’s own attribution rule', () => {
    const rows = [
      endedIn(20_000, { id: 'atlas-run', botId: 'atlas' }),
      endedIn(900_000, { id: 'bramble-run', botId: 'bramble' }),
    ];

    expect(medianRunMs(filterRunsByBot(rows, { botId: 'atlas' }), NOW)).toBe(20_000);
    // The rows that name no Bot are their own card, and this read has none.
    expect(medianRunMs(filterRunsByBot(rows, { botId: null }), NOW)).toBeNull();
  });
});

describe('scorecardDurationCopy', () => {
  test('names the median span the card can back', () => {
    expect(scorecardDurationCopy(222_000)).toBe('Median run 3:42');
  });

  test('a card with nothing it can time prints nothing, never a zero', () => {
    // `0:00` would read as a Bot whose runs took no time at all.
    expect(scorecardDurationCopy(null)).toBe('');
    expect(scorecardDurationCopy(0)).toBe('');
    expect(scorecardDurationCopy(Number.NaN)).toBe('');
  });

  test('claims no statistic this module did not compute', () => {
    expect(scorecardDurationCopy(222_000)).not.toMatch(/average|typical|gateway|total/i);
  });
});
