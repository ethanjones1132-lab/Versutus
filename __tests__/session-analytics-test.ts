import {
  applySessionSpendRead,
  EMPTY_SESSION_SPEND,
  overflowSpendCopy,
  overflowSpendSession,
  relativeMeter,
  sessionSpendCopy,
  sessionSpendReadFromUnknown,
  sessionUsage,
  threadSpendCopy,
  threadSpendRefreshKey,
  threadUsage,
  totalUsage,
  weekBuckets,
} from '@/lib/gateway/session-analytics';

describe('sessionUsage', () => {
  test('sums tokens and prefers actual cost', () => {
    expect(
      sessionUsage({
        input_tokens: 100,
        output_tokens: 50,
        actual_cost_usd: 0.02,
        estimated_cost_usd: 0.99,
      }),
    ).toEqual({ tokens: 150, costUsd: 0.02 });
  });

  test('missing token fields count as 0 and missing costs are null', () => {
    expect(sessionUsage({})).toEqual({ tokens: 0, costUsd: null });
    expect(sessionUsage({ estimated_cost_usd: 1.5 })).toEqual({ tokens: 0, costUsd: 1.5 });
  });
});

describe('relativeMeter', () => {
  test('0/0 is ratio 0', () => {
    expect(relativeMeter(0, 0)).toEqual({ value: 0, peak: 0, ratio: 0 });
  });

  test('value above week max becomes the peak and ratio never exceeds 1', () => {
    expect(relativeMeter(10, 5)).toEqual({ value: 10, peak: 10, ratio: 1 });
    expect(relativeMeter(5, 10)).toEqual({ value: 5, peak: 10, ratio: 0.5 });
  });
});

describe('weekBuckets', () => {
  const noonOn = (year: number, monthIndex: number, day: number) =>
    new Date(year, monthIndex, day, 12, 0, 0).getTime();

  test('returns 7 local days ending today, oldest first', () => {
    const now = new Date(2026, 7, 19, 15, 0, 0).getTime();
    const buckets = weekBuckets([], now);
    expect(buckets).toHaveLength(7);
    expect(buckets[0].startMs).toBe(new Date(2026, 7, 13).getTime());
    expect(buckets[6].startMs).toBe(new Date(2026, 7, 19).getTime());
    expect(buckets.every((bucket) => bucket.tokens === 0 && bucket.costUsd === 0)).toBe(true);
  });

  test('groups by local day, skips missing timestamps, accepts unix seconds', () => {
    const now = new Date(2026, 7, 19, 15, 0, 0).getTime();
    const buckets = weekBuckets(
      [
        { last_active: noonOn(2026, 7, 19) / 1000, input_tokens: 10, output_tokens: 5, actual_cost_usd: 0.4 },
        { last_active: noonOn(2026, 7, 13), input_tokens: 20, output_tokens: 0, estimated_cost_usd: 0.1 },
        { last_active: noonOn(2026, 7, 12), input_tokens: 999, output_tokens: 0 },
        { input_tokens: 50, output_tokens: 50 },
      ],
      now,
    );
    expect(buckets[6].tokens).toBe(15);
    expect(buckets[6].costUsd).toBe(0.4);
    expect(buckets[0].tokens).toBe(20);
    expect(buckets[0].costUsd).toBe(0.1);
    expect(buckets.reduce((sum, bucket) => sum + bucket.tokens, 0)).toBe(35);
  });
});

describe('totalUsage', () => {
  test('sums tokens across sessions and adds only known costs', () => {
    expect(
      totalUsage([
        { input_tokens: 100, output_tokens: 50, actual_cost_usd: 0.5, estimated_cost_usd: 0.99 },
        { input_tokens: 20, output_tokens: 5, estimated_cost_usd: 0.25 },
        { input_tokens: 10 },
      ]),
    ).toEqual({ sessionCount: 3, tokens: 185, costUsd: 0.75 });
  });

  test('an empty list is zero tokens and unknown cost, not $0', () => {
    expect(totalUsage([])).toEqual({ sessionCount: 0, tokens: 0, costUsd: null });
  });

  test('sessions with no cost field stay cost-unknown', () => {
    expect(totalUsage([{ input_tokens: 10, output_tokens: 5 }])).toEqual({
      sessionCount: 1,
      tokens: 15,
      costUsd: null,
    });
  });
});

describe('sessionSpendCopy', () => {
  test('names session count, tokens, and cost', () => {
    expect(sessionSpendCopy({ sessionCount: 2, tokens: 1500, costUsd: 0.42 })).toBe(
      'Sessions: 2\nTokens: 1.5k\nCost: $0.42',
    );
  });

  test('unknown cost is an em dash, not $0.00', () => {
    expect(sessionSpendCopy({ sessionCount: 0, tokens: 0, costUsd: null })).toBe(
      'Sessions: 0\nTokens: 0\nCost: —',
    );
  });
});

describe('sessionSpendReadFromUnknown', () => {
  test('unwraps a Gate { data } list and a raw array', () => {
    const session = { input_tokens: 10, output_tokens: 5, actual_cost_usd: 0.4 };
    expect(sessionSpendReadFromUnknown({ object: 'list', data: [session] })).toEqual({
      ok: true,
      sessions: [session],
    });
    expect(sessionSpendReadFromUnknown([session])).toEqual({ ok: true, sessions: [session] });
    expect(sessionSpendReadFromUnknown({ sessions: [session] })).toEqual({
      ok: true,
      sessions: [session],
    });
  });

  test('an empty list is empty-ok', () => {
    expect(sessionSpendReadFromUnknown([])).toEqual({ ok: true, sessions: [] });
    expect(sessionSpendReadFromUnknown({ data: [] })).toEqual({ ok: true, sessions: [] });
  });

  test('non-object items are dropped, not a failed read', () => {
    const read = sessionSpendReadFromUnknown([null, 42, { input_tokens: 3 }]);
    expect(read).toEqual({ ok: true, sessions: [{ input_tokens: 3 }] });
  });

  test('an unparseable payload is a failed read, not zero spend', () => {
    expect(sessionSpendReadFromUnknown(null).ok).toBe(false);
    expect(sessionSpendReadFromUnknown('nope').ok).toBe(false);
    expect(sessionSpendReadFromUnknown({ error: 'boom' }).ok).toBe(false);
  });

  test('keeps id from id, sessionId, or name so this thread can be found', () => {
    expect(sessionSpendReadFromUnknown([{ id: 's1', input_tokens: 4 }])).toEqual({
      ok: true,
      sessions: [{ id: 's1', input_tokens: 4 }],
    });
    expect(sessionSpendReadFromUnknown([{ sessionId: 's2', output_tokens: 1 }])).toEqual({
      ok: true,
      sessions: [{ id: 's2', output_tokens: 1 }],
    });
    expect(sessionSpendReadFromUnknown([{ name: 's3', actual_cost_usd: 0.1 }])).toEqual({
      ok: true,
      sessions: [{ id: 's3', actual_cost_usd: 0.1 }],
    });
  });

  test('prefers id over sessionId over name', () => {
    expect(
      sessionSpendReadFromUnknown([{ id: 'keep', sessionId: 'other', name: 'also', input_tokens: 1 }]),
    ).toEqual({
      ok: true,
      sessions: [{ id: 'keep', input_tokens: 1 }],
    });
  });
});

describe('applySessionSpendRead', () => {
  test('a failed FIRST read claims zero knowledge — not zero spend', () => {
    const next = applySessionSpendRead(EMPTY_SESSION_SPEND, { ok: false });
    expect(next.sessions).toEqual([]);
    expect(next.loaded).toBe(false);
    expect(next.failed).toBe(true);
    expect(threadSpendCopy(next, 's1')).toBe('Spend could not be read.');
    expect(threadSpendCopy(next, 's1')).not.toMatch(/0|\$/);
  });

  test('a failed RE-read keeps last-good spend for this thread', () => {
    const loaded = applySessionSpendRead(EMPTY_SESSION_SPEND, {
      ok: true,
      sessions: [{ id: 's1', input_tokens: 100, output_tokens: 50, actual_cost_usd: 0.42 }],
    });
    const stale = applySessionSpendRead(loaded, { ok: false });
    expect(stale.sessions).toEqual([
      { id: 's1', input_tokens: 100, output_tokens: 50, actual_cost_usd: 0.42 },
    ]);
    expect(stale.loaded).toBe(true);
    expect(stale.failed).toBe(true);
    expect(threadSpendCopy(stale, 's1')).toBe('150 · $0.42');
  });

  test('a successful refresh replaces the list', () => {
    const previous = applySessionSpendRead(EMPTY_SESSION_SPEND, {
      ok: true,
      sessions: [{ id: 's1', input_tokens: 10 }],
    });
    const next = applySessionSpendRead(previous, {
      ok: true,
      sessions: [{ id: 's1', input_tokens: 20, actual_cost_usd: 0.42 }],
    });
    expect(next.failed).toBe(false);
    expect(threadSpendCopy(next, 's1')).toBe('20 · $0.42');
  });
});

describe('threadUsage', () => {
  const sessions = [
    { id: 'other', input_tokens: 999, actual_cost_usd: 9 },
    { id: 'open', input_tokens: 100, output_tokens: 50, actual_cost_usd: 0.42 },
  ];

  test('returns this thread, not the total of every session', () => {
    expect(threadUsage(sessions, 'open')).toEqual({ tokens: 150, costUsd: 0.42 });
    expect(totalUsage(sessions)).toEqual({ sessionCount: 2, tokens: 1149, costUsd: 9.42 });
  });

  test('a missing or blank session id is not a match', () => {
    expect(threadUsage(sessions, undefined)).toBeUndefined();
    expect(threadUsage(sessions, '  ')).toBeUndefined();
    expect(threadUsage(sessions, 'gone')).toBeUndefined();
  });
});

describe('threadSpendCopy', () => {
  test('names this thread tokens and cost without opening the selector', () => {
    const state = applySessionSpendRead(EMPTY_SESSION_SPEND, {
      ok: true,
      sessions: [{ id: 's1', input_tokens: 1400, output_tokens: 100, actual_cost_usd: 0.42 }],
    });
    expect(threadSpendCopy(state, 's1')).toBe('1.5k · $0.42');
  });

  test('unknown cost is an em dash, not $0.00', () => {
    const state = applySessionSpendRead(EMPTY_SESSION_SPEND, {
      ok: true,
      sessions: [{ id: 's1', input_tokens: 10 }],
    });
    expect(threadSpendCopy(state, 's1')).toBe('10 · —');
  });

  test('a successful list that does not contain this thread is empty-ok, not a miss', () => {
    const state = applySessionSpendRead(EMPTY_SESSION_SPEND, {
      ok: true,
      sessions: [{ id: 'other', input_tokens: 10, actual_cost_usd: 1 }],
    });
    expect(threadSpendCopy(state, 'new-session')).toBeUndefined();
    expect(threadSpendCopy(EMPTY_SESSION_SPEND, 's1')).toBeUndefined();
  });

  test('a failed re-read without this thread in last-good names the miss', () => {
    const loaded = applySessionSpendRead(EMPTY_SESSION_SPEND, {
      ok: true,
      sessions: [{ id: 'other', input_tokens: 10 }],
    });
    const stale = applySessionSpendRead(loaded, { ok: false });
    expect(threadSpendCopy(stale, 'open')).toBe('Could not re-read spend — showing the last total.');
  });
});

describe('overflowSpendCopy', () => {
  test('a failed first read names the miss, never the session selector', () => {
    const next = applySessionSpendRead(EMPTY_SESSION_SPEND, { ok: false });
    expect(overflowSpendCopy(next, 's1')).toBe('Spend could not be read.');
    expect(overflowSpendCopy(next, 's1')).not.toMatch(/selector|Sessions/i);
  });

  test('unread and empty-ok stay silent — opening Sessions is not the load path', () => {
    expect(overflowSpendCopy(EMPTY_SESSION_SPEND, 's1')).toBeUndefined();
    const emptyOk = applySessionSpendRead(EMPTY_SESSION_SPEND, {
      ok: true,
      sessions: [{ id: 'other', input_tokens: 10, actual_cost_usd: 1 }],
    });
    expect(overflowSpendCopy(emptyOk, 's1')).toBeUndefined();
  });

  test('this thread is the glance fold, not a selector row', () => {
    const state = applySessionSpendRead(EMPTY_SESSION_SPEND, {
      ok: true,
      sessions: [{ id: 's1', input_tokens: 1400, output_tokens: 100, actual_cost_usd: 0.42 }],
    });
    expect(overflowSpendCopy(state, 's1')).toBe(threadSpendCopy(state, 's1'));
    expect(overflowSpendCopy(state, 's1')).toBe('1.5k · $0.42');
  });

  test('a failed re-read keeps last-good copy without a selector prompt', () => {
    const loaded = applySessionSpendRead(EMPTY_SESSION_SPEND, {
      ok: true,
      sessions: [{ id: 's1', input_tokens: 100, output_tokens: 50, actual_cost_usd: 0.42 }],
    });
    const stale = applySessionSpendRead(loaded, { ok: false });
    expect(overflowSpendCopy(stale, 's1')).toBe('150 · $0.42');
    expect(overflowSpendCopy(stale, 's1')).not.toMatch(/selector/i);
  });
});

describe('overflowSpendSession', () => {
  test('keeps this thread input and output separate — not a stuffed total', () => {
    const state = applySessionSpendRead(EMPTY_SESSION_SPEND, {
      ok: true,
      sessions: [{ id: 's1', input_tokens: 100, output_tokens: 50, actual_cost_usd: 0.42 }],
    });
    expect(overflowSpendSession(state, 's1')).toEqual({
      id: 's1',
      input_tokens: 100,
      output_tokens: 50,
      actual_cost_usd: 0.42,
    });
  });

  test('a failed first read has no session to meter', () => {
    const next = applySessionSpendRead(EMPTY_SESSION_SPEND, { ok: false });
    expect(overflowSpendSession(next, 's1')).toBeUndefined();
  });

  test('a failed re-read keeps last-good for the sparkline', () => {
    const loaded = applySessionSpendRead(EMPTY_SESSION_SPEND, {
      ok: true,
      sessions: [
        { id: 's1', input_tokens: 100, output_tokens: 50, last_active: 1_700_000_000 },
        { id: 'other', input_tokens: 10 },
      ],
    });
    const stale = applySessionSpendRead(loaded, { ok: false });
    expect(overflowSpendSession(stale, 's1')).toEqual({
      id: 's1',
      input_tokens: 100,
      output_tokens: 50,
      last_active: 1_700_000_000,
    });
  });

  test('a successful list that does not contain this thread is empty-ok', () => {
    const state = applySessionSpendRead(EMPTY_SESSION_SPEND, {
      ok: true,
      sessions: [{ id: 'other', input_tokens: 10 }],
    });
    expect(overflowSpendSession(state, 's1')).toBeUndefined();
    expect(overflowSpendSession(EMPTY_SESSION_SPEND, 's1')).toBeUndefined();
  });
});

describe('threadSpendRefreshKey', () => {
  const open = { surfaceKey: 'bot:research', sessionId: 's1' };

  test('a finished send is a different key than the live send, so the glance re-reads', () => {
    const live = threadSpendRefreshKey({ ...open, sending: true });
    const done = threadSpendRefreshKey({ ...open, sending: false });
    expect(live).toBeTruthy();
    expect(done).toBeTruthy();
    expect(live).not.toBe(done);
  });

  test('the same idle thread keeps one key — navigation did not happen', () => {
    expect(threadSpendRefreshKey({ ...open, sending: false })).toBe(
      threadSpendRefreshKey({ ...open, sending: false }),
    );
  });

  test('a different session or surface is a new key, the way the first-read already is', () => {
    const idle = threadSpendRefreshKey({ ...open, sending: false });
    expect(threadSpendRefreshKey({ ...open, sessionId: 's2', sending: false })).not.toBe(idle);
    expect(
      threadSpendRefreshKey({ surfaceKey: 'cfg:hermes', sessionId: 's1', sending: false }),
    ).not.toBe(idle);
  });

  test('roster and group rooms have no glance key', () => {
    expect(threadSpendRefreshKey({ surfaceKey: undefined, sessionId: 's1', sending: false })).toBeUndefined();
  });
});
