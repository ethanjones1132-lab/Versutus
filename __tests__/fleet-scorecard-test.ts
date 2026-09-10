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

import { buildScorecards, scorecardFate, scorecardWindowCopy, SCORECARD_FOOTER_COPY } from '@/lib/fleet/scorecard';
import type { BotScorecard } from '@/lib/fleet/scorecard';
import { ACTIVITY_RUNS_PERSIST_CAP } from '@/lib/gateway/session-persistence';
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
