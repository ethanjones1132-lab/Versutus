// The scorecard fold: the run rows this device persisted, gathered into one
// card per Bot (FUTURE-ITEMS.md §D3 Build 1). A card is a claim about a Bot's
// track record, so the two ways a count can lie are pinned here: a cancelled
// run is not a failure (D3:803-804), and a row that names no Bot is neither
// dropped nor guessed into someone else's card (D3:792-797).

import { buildScorecards, scorecardFate } from '@/lib/fleet/scorecard';
import type { BotScorecard } from '@/lib/fleet/scorecard';
import type { ActivityRun } from '@/lib/gateway/runs';

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
