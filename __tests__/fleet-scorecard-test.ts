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
  scorecardApprovalCopy,
  scorecardApprovals,
  scorecardBotLabel,
  scorecardDurationCopy,
  scorecardFate,
  scorecardFateCopy,
  scorecardRoutineCopy,
  scorecardRoutineHealth,
  scorecardSpendCopy,
  scorecardWindowCopy,
  watchedRunSpanMs,
  withSpend,
  SCORECARD_FOOTER_COPY,
} from '@/lib/fleet/scorecard';
import type {
  BotScorecard,
  ScorecardApprovals,
  ScorecardFates,
  ScorecardRoutineHealth,
} from '@/lib/fleet/scorecard';
import { ACTIVITY_RUNS_PERSIST_CAP, normalizeRestoredRuns } from '@/lib/gateway/session-persistence';
import type { CronJob } from '@/lib/gateway/cron';
import { botSpendRowCopy, SPEND_UNREAD_COPY, type BotSpendRow } from '@/lib/gateway/spend-report';
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

describe('scorecardApprovals', () => {
  /** A row that met an approval gate: the decision the provider recorded on it. */
  const decided = (approved: boolean, over: Partial<ActivityRun> = {}): ActivityRun =>
    run({ status: approved ? 'complete' : 'failed', approved, ...over });

  test('counts each approval the card’s rows recorded', () => {
    const approvals = scorecardApprovals([
      decided(true, { id: 'granted' }),
      decided(false, { id: 'denied' }),
      run({ id: 'waiting', status: 'waiting-approval', finishedAt: undefined }),
      run({ id: 'plain', status: 'complete' }),
    ]);

    expect(approvals).toEqual({ asked: 3, granted: 1, denied: 1, pending: 1 });
  });

  test('a row that never met an approval gate counts in none of them', () => {
    // The shape of every row persisted before the field existed, and of every
    // run that just ran: no decision and no wait, so it is not a denial either.
    const approvals = scorecardApprovals([
      run({ id: 'legacy', status: 'complete' }),
      run({ id: 'failed-without-a-gate', status: 'failed' }),
      run({ id: 'stopped', status: 'cancelled' }),
      run({ id: 'unknown', status: 'unresolved' }),
    ]);

    expect(approvals).toEqual({ asked: 0, granted: 0, denied: 0, pending: 0 });
  });

  test('a half-shaped decision is not a decision', () => {
    // `approved` is typed on the row, but a row read back off disk is not a
    // row this module can trust: only a real boolean counts, so a value that
    // is merely truthy cannot read as a refusal the operator made.
    const approvals = scorecardApprovals([
      run({ id: 'corrupt', approved: 'yes' as unknown as boolean }),
    ]);

    expect(approvals.asked).toBe(0);
    expect(approvals.denied).toBe(0);
  });

  test('every approval lands in exactly one count, and asked is their sum', () => {
    const approvals = scorecardApprovals([
      decided(true, { id: 'a' }),
      decided(true, { id: 'b', status: 'running', finishedAt: undefined }),
      decided(false, { id: 'c' }),
      run({ id: 'd', status: 'waiting-approval', finishedAt: undefined }),
      run({ id: 'e', status: 'complete' }),
      run({ id: 'f' }),
    ]);

    expect(approvals.asked).toBe(approvals.granted + approvals.denied + approvals.pending);
    expect(approvals.asked).toBe(4);
  });

  test('a request the app was killed under is not still waiting', () => {
    // The restore re-marks every in-flight row, so the resolver that promise
    // pointed at is gone: nothing on this device can answer it any more, and
    // a card must not read as blocked on an operator who cannot decide it.
    const restored = normalizeRestoredRuns([
      run({ id: 'killed', status: 'waiting-approval', finishedAt: undefined }),
    ]);

    expect(restored[0].status).toBe('unresolved');
    expect(scorecardApprovals(restored)).toEqual({ asked: 0, granted: 0, denied: 0, pending: 0 });
  });

  test('a card with no runs at all asked for nothing', () => {
    expect(scorecardApprovals([])).toEqual({ asked: 0, granted: 0, denied: 0, pending: 0 });
  });
});

describe('scorecardApprovalCopy', () => {
  const approvals = (over: Partial<ScorecardApprovals>): ScorecardApprovals => ({
    asked: 0,
    granted: 0,
    denied: 0,
    pending: 0,
    ...over,
  });

  test('states the rate over the approvals the operator answered', () => {
    expect(scorecardApprovalCopy(approvals({ asked: 3, granted: 2, denied: 1 }))).toBe(
      '2 of 3 approvals granted',
    );
  });

  test('a request still waiting is named beside the rate, never counted as one', () => {
    const copy = scorecardApprovalCopy(approvals({ asked: 4, granted: 2, denied: 1, pending: 1 }));

    expect(copy).toBe('2 of 3 approvals granted · 1 waiting on you');
    // The unanswered request is not in the denominator: `2 of 4` would read as
    // a refusal the operator never made.
    expect(copy).not.toContain('of 4');
  });

  test('approvals merely asked for carry no rate at all', () => {
    const copy = scorecardApprovalCopy(approvals({ asked: 2, pending: 2 }));

    expect(copy).toBe('2 waiting on you');
    expect(copy).not.toMatch(/granted|%/);
  });

  test('a card whose approvals were all refused says 0 granted, never 0%', () => {
    // A true count is honest where a rate over rows that decided nothing
    // would not be.
    expect(scorecardApprovalCopy(approvals({ asked: 2, denied: 2 }))).toBe(
      '0 of 2 approvals granted',
    );
  });

  test('one approval is one approval', () => {
    expect(scorecardApprovalCopy(approvals({ asked: 1, granted: 1 }))).toBe(
      '1 of 1 approval granted',
    );
  });

  test('a card whose rows met no gate says nothing, never 0 of 0', () => {
    expect(scorecardApprovalCopy(approvals({}))).toBe('');
  });

  test('claims no statistic this module did not compute', () => {
    const copy = scorecardApprovalCopy(approvals({ asked: 3, granted: 2, denied: 1 }));

    expect(copy).not.toMatch(/average|rate|gateway|total|%/i);
  });
});

describe('scorecardRoutineHealth', () => {
  /** One scheduled job; its Bot comes from the `[bot:<name>]` convention. */
  const job = (over: Partial<CronJob> = {}): CronJob => ({ id: 'job-1', title: 'Sweep', ...over });

  test('a Bot’s routines are grouped under the Bot its name carries', () => {
    const groups = scorecardRoutineHealth([
      job({ id: 'a', name: '[bot:scout] Sweep' }),
      job({ id: 'b', name: '[bot:scout] Digest' }),
      job({ id: 'c', name: '[bot:echo] Inbox', lastStatus: 'ok' }),
    ]);

    expect(groups.get('scout')?.routines).toBe(2);
    expect(groups.get('echo')?.routines).toBe(1);
  });

  test('a failure streak outranks an ok job', () => {
    const groups = scorecardRoutineHealth([
      job({ id: 'a', name: '[bot:scout] Sweep', lastStatus: 'ok' }),
      job({ id: 'b', name: '[bot:scout] Digest', failureStreak: 2, lastError: 'boom' }),
    ]);

    expect(groups.get('scout')?.verdict.tone).toBe('error');
    expect(groups.get('scout')?.verdict.label).toBe('Failing — 2 in a row');
    // The count is the routines it covered, not the one that failed.
    expect(groups.get('scout')?.routines).toBe(2);
  });

  test('a paused routine reads off rather than failing', () => {
    const groups = scorecardRoutineHealth([
      job({ name: '[bot:scout] Sweep', paused: true, failureStreak: 3, lastError: 'boom' }),
    ]);

    // `describeCronHealth`'s own rule: a paused job is off on purpose, and
    // calling it failing would send the operator hunting a bug that is not there.
    expect(groups.get('scout')?.verdict.tone).toBe('off');
    expect(groups.get('scout')?.verdict.label).toBe('Paused');
  });

  test('a routine with no streak reads as ok', () => {
    const groups = scorecardRoutineHealth([job({ name: '[bot:scout] Sweep', lastStatus: 'ok' })]);

    expect(groups.get('scout')?.verdict.tone).toBe('ok');
  });

  test('a cooldown outranks an ok routine', () => {
    const groups = scorecardRoutineHealth([
      job({ id: 'a', name: '[bot:scout] Sweep', lastStatus: 'ok' }),
      job({ id: 'b', name: '[bot:scout] Digest', cooldownReason: 'the host is throttling itself' }),
    ]);

    expect(groups.get('scout')?.verdict.tone).toBe('warn');
    expect(groups.get('scout')?.verdict.detail).toBe('the host is throttling itself');
  });

  test('a routine the host says nothing about outranks a healthy one', () => {
    const groups = scorecardRoutineHealth([
      job({ id: 'a', name: '[bot:scout] Sweep', lastStatus: 'ok' }),
      job({ id: 'b', name: '[bot:scout] Digest' }),
    ]);

    // Absent data reads as UNKNOWN, never as a reassuring claim (cron.ts:7-10).
    expect(groups.get('scout')?.verdict.tone).toBe('unknown');
    expect(groups.get('scout')?.verdict.label).toBe('Not run yet');
  });

  test('a paused routine is not worse than one that is failing', () => {
    const groups = scorecardRoutineHealth([
      job({ id: 'a', name: '[bot:scout] Sweep', paused: true }),
      job({ id: 'b', name: '[bot:scout] Digest', failureStreak: 1, lastError: 'boom' }),
    ]);

    expect(groups.get('scout')?.verdict.tone).toBe('error');
  });

  test('a job whose name carries no Bot is attributed to nobody', () => {
    const groups = scorecardRoutineHealth([
      job({ id: 'a', name: 'Overnight mail summary' }),
      job({ id: 'b' }),
      job({ id: 'c', name: null }),
    ]);

    // The gateway-level jobs share the unattributed bucket rather than being
    // guessed into some Bot's card — the same rule a run row with no `botId` gets.
    expect(groups.get(null)?.routines).toBe(3);
    expect(groups.get('scout')).toBeUndefined();
  });

  test('the empty read groups nothing', () => {
    const groups = scorecardRoutineHealth([]);

    expect(groups.size).toBe(0);
    expect(groups.get('scout')).toBeUndefined();
  });
});

describe('scorecardRoutineCopy', () => {
  const health = (over: Partial<ScorecardRoutineHealth> = {}): ScorecardRoutineHealth => ({
    routines: 1,
    verdict: { tone: 'ok', label: 'ok' },
    ...over,
  });

  test('states the health fold’s own verdict and how many routines it covered', () => {
    expect(scorecardRoutineCopy(health({ routines: 2 }))).toBe('2 routines · ok');
  });

  test('one routine is one routine', () => {
    expect(scorecardRoutineCopy(health({ verdict: { tone: 'off', label: 'Paused' } }))).toBe(
      '1 routine · Paused',
    );
  });

  test('a failing routine carries the verdict the health fold wrote', () => {
    const copy = scorecardRoutineCopy(
      health({ routines: 3, verdict: { tone: 'error', label: 'Failing — 2 in a row' } }),
    );

    expect(copy).toBe('3 routines · Failing — 2 in a row');
    // The words are `describeCronHealth`'s, so the routine surfaces and the card
    // cannot describe one host state two ways.
    expect(copy).not.toContain('backend');
  });

  test('a card with no routines says nothing, never 0 routines', () => {
    expect(scorecardRoutineCopy(undefined)).toBe('');
    expect(scorecardRoutineCopy(health({ routines: 0 }))).toBe('');
  });

  test('the run-derived part of a card never absorbs this number', () => {
    const copy = scorecardRoutineCopy(health({ routines: 2 }));

    // The count says what it counts: a bare number here would read as runs.
    expect(copy).toMatch(/^2 routines · /);
    expect(copy).not.toMatch(/complete|approval|median|%/i);
  });
});

describe('withSpend', () => {
  /** One Bot's spend, as P5's `readBotSpend` folds it — costed until a case says otherwise. */
  const spendRow = (over: Partial<BotSpendRow> = {}): BotSpendRow => ({
    botId: 'atlas',
    label: 'Atlas',
    basis: 'actual',
    tokens: 12_345,
    costUsd: 0.42,
    failed: false,
    ...over,
  });

  /** Two cards, so a row can be shown to land on its own Bot's and no other. */
  const cards = (): BotScorecard[] =>
    buildScorecards([
      run({ id: 'a', botId: 'atlas', status: 'complete' }),
      run({ id: 'b', botId: 'bramble', status: 'failed' }),
    ]);

  test('a card carries the spend row its own Bot’s read folded', () => {
    const merged = withSpend(cards(), [
      spendRow({ botId: 'atlas' }),
      spendRow({ botId: 'bramble', tokens: 200, costUsd: 1.5 }),
    ]);

    expect(cardFor(merged, 'atlas').spend?.tokens).toBe(12_345);
    expect(cardFor(merged, 'bramble').spend?.tokens).toBe(200);
    // The card is otherwise the fold's own: the spend is a field on it, not a
    // second fold of the runs.
    expect(cardFor(merged, 'atlas').fates.complete).toBe(1);
  });

  test('a card the spend read holds no row for carries no spend at all', () => {
    const merged = withSpend(cards(), [spendRow({ botId: 'atlas' })]);

    expect(cardFor(merged, 'bramble').spend).toBeUndefined();
    // No empty field, so nothing on that card can print a zero it never read.
    expect(Object.keys(cardFor(merged, 'bramble')).sort()).toEqual(['botId', 'fates', 'total']);
  });

  test('an empty spend read spends nothing, rather than zero per card', () => {
    const merged = withSpend(cards(), []);

    expect(merged.every((card) => card.spend === undefined)).toBe(true);
  });

  test('an id that is not an id is the unattributed row, never a Bot’s', () => {
    const merged = withSpend(
      buildScorecards([run({ id: 'legacy' }), run({ id: 'atlas-run', botId: 'atlas' })]),
      [spendRow({ botId: '', label: 'Not a Bot' })],
    );

    // The same rule the fold buckets a run row by, applied to both sides.
    expect(cardFor(merged, null).spend?.label).toBe('Not a Bot');
    expect(cardFor(merged, 'atlas').spend).toBeUndefined();
  });

  test('a Bot the spend read holds but this device has no runs for gets no card', () => {
    const merged = withSpend(buildScorecards([run({ id: 'atlas-run', botId: 'atlas' })]), [
      spendRow({ botId: 'echo', label: 'Echo' }),
    ]);

    // An empty card would read as a Bot that fails at nothing.
    expect(merged.map((card) => card.botId)).toEqual(['atlas']);
    expect(cardFor(merged, 'atlas').spend).toBeUndefined();
  });

  test('a failed read is merged as the failure it is, never as a zero', () => {
    const merged = withSpend(cards(), [
      spendRow({ botId: 'atlas', failed: true, basis: null, tokens: null, costUsd: null }),
    ]);
    const card = cardFor(merged, 'atlas');

    expect(card.spend?.failed).toBe(true);
    expect(card.spend?.tokens).toBeNull();
    expect(card.spend?.costUsd).toBeNull();
  });

  test('the cards the fold built are left as they were', () => {
    const original = cards();
    const merged = withSpend(original, [spendRow()]);

    expect(merged).not.toBe(original);
    expect(original.every((card) => card.spend === undefined)).toBe(true);
    expect(merged.map((card) => card.botId)).toEqual(original.map((card) => card.botId));
  });
});

describe('scorecardSpendCopy', () => {
  /** One Bot's spend, as P5's `readBotSpend` folds it — costed until a case says otherwise. */
  const spendRow = (over: Partial<BotSpendRow> = {}): BotSpendRow => ({
    botId: 'atlas',
    label: 'Atlas',
    basis: 'actual',
    tokens: 12_345,
    costUsd: 0.42,
    failed: false,
    ...over,
  });

  test('a card states its Bot’s spend in the read’s own words', () => {
    const spend = spendRow();

    expect(scorecardSpendCopy(spend)).toBe(botSpendRowCopy(spend));
    expect(scorecardSpendCopy(spend)).toContain('tokens');
  });

  test('the basis travels with the number, so no card is read as a bill', () => {
    const copy = scorecardSpendCopy(spendRow({ basis: 'estimated' }));

    expect(copy).toContain('estimated');
  });

  test('a read that failed keeps its unread line rather than a zero', () => {
    const copy = scorecardSpendCopy(
      spendRow({ failed: true, basis: null, tokens: null, costUsd: null }),
    );

    expect(copy).toBe(SPEND_UNREAD_COPY);
    expect(copy).not.toMatch(/0 tokens|\$0/);
  });

  test('a card with no spend row says nothing at all', () => {
    expect(scorecardSpendCopy(undefined)).toBe('');
  });

  test('one wording for one fact, so the Spend screen and a card cannot disagree', () => {
    // Every row shape the spend read can fold, re-worded nowhere.
    for (const spend of [
      spendRow(),
      spendRow({ basis: 'none', costUsd: null }),
      spendRow({ failed: true, basis: null, tokens: null, costUsd: null }),
    ]) {
      expect(scorecardSpendCopy(spend)).toBe(botSpendRowCopy(spend));
    }
  });
});

describe('watchedRunSpanMs', () => {
  const NOW = 1_757_400_000_000;

  /** A row that ended `ms` before NOW — one span this device watched end. */
  const endedIn = (ms: number, over: Partial<ActivityRun> = {}): ActivityRun =>
    run({ startedAt: NOW - ms, finishedAt: NOW, ...over });

  test('a run this device watched end answers its span', () => {
    // The one rule the run card and the median fold share, so a single run's
    // card and a Bot's card cannot disagree about what counts as a time.
    expect(watchedRunSpanMs(endedIn(30_000), NOW)).toBe(30_000);
    expect(watchedRunSpanMs(endedIn(30_000, { status: 'failed' }), NOW)).toBe(30_000);
    expect(watchedRunSpanMs(endedIn(30_000, { status: 'cancelled' }), NOW)).toBe(30_000);
  });

  test('a run whose end this device never learned answers no span', () => {
    // `unresolved` is settled for the counts and out for a duration: its finish
    // is when this client stopped polling (runs.ts:25-30).
    expect(watchedRunSpanMs(endedIn(900_000, { status: 'unresolved' }), NOW)).toBeNull();
    expect(
      watchedRunSpanMs(run({ status: 'running', startedAt: NOW - 900_000, finishedAt: undefined }), NOW),
    ).toBeNull();
    expect(
      watchedRunSpanMs(
        run({ status: 'waiting-approval', startedAt: NOW - 900_000, finishedAt: undefined }),
        NOW,
      ),
    ).toBeNull();
  });

  test('the row the app interrupted on load answers no span', () => {
    const restored = normalizeRestoredRuns([
      run({ id: 'killed', status: 'running', startedAt: NOW - 900_000, finishedAt: undefined }),
    ]);

    // The load-time stamp is how long the app was CLOSED, never a run time.
    expect(restored[0].status).toBe('unresolved');
    expect(watchedRunSpanMs(restored[0])).toBeNull();
  });

  test('a finish this read cannot trust is no span either', () => {
    // A placeholder past the fold's clock, a finish at or before its own start,
    // a half-shaped row and a timestamp that is not a number are all refused.
    expect(watchedRunSpanMs(endedIn(60_000, { finishedAt: NOW + 5_000 }), NOW)).toBeNull();
    expect(watchedRunSpanMs(endedIn(0), NOW)).toBeNull();
    expect(watchedRunSpanMs(run({ startedAt: NOW, finishedAt: NOW - 5_000 }), NOW)).toBeNull();
    expect(watchedRunSpanMs(run({ startedAt: Number.NaN, finishedAt: NOW }), NOW)).toBeNull();
    expect(watchedRunSpanMs(run({ startedAt: NOW - 1_000, finishedAt: undefined }), NOW)).toBeNull();
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
