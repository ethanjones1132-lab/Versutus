import {
  applySessionSpendRead,
  EMPTY_SESSION_SPEND,
  SESSION_SPEND_LIST_LIMIT,
  sessionSpendReadFromUnknown,
  THREAD_SPEND_GLANCE_LIMIT,
  THREAD_SPEND_MIN_READ_MS,
  threadSpendFinishedRead,
  threadSpendNeedsWideRead,
  threadSpendRefreshKey,
} from '@/lib/gateway/session-analytics';

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

const chatScreen = readSource('src', 'components', 'chat', 'chat-screen.tsx');

const OPEN = { surfaceKey: 'bot:research', sessionId: 's1' };

/** One row the glance folds, shaped like a `sessions.list` row. */
function row(id: string, tokens = 10) {
  return { id, input_tokens: tokens, output_tokens: 0, actual_cost_usd: 0.01 };
}

describe('a turn starting costs the glance nothing', () => {
  test('the refresh key is the same before and after a send starts', () => {
    expect(threadSpendRefreshKey({ ...OPEN, sending: true })).toBe(
      threadSpendRefreshKey({ ...OPEN, sending: false }),
    );
  });

  test('chat-screen spends nothing on the sending flag but still names it', () => {
    // `sending` stays in the call because the signature is public, but it is
    // not folded into the key that runs the read.
    const call = chatScreen.match(/threadSpendRefreshKey\(\{[\s\S]*?\}\);/)?.[0];
    expect(call).toBeDefined();
    expect(call).toContain('sending: isSending,');
    const key = chatScreen.match(/const spendEffectKey =[\s\S]*?;$/m)?.[0];
    expect(key).toBeDefined();
    expect(key).not.toContain('spendRefreshKey}:retry${spendRetryTick}`');
  });
});

describe('a turn finishing buys exactly one re-read', () => {
  /** The edges chat-screen's finish effect sees, in order, on one surface. */
  function edge(wasSending: boolean, sending: boolean, lastReadAt: number | undefined, now: number) {
    return threadSpendFinishedRead({ surfaceKey: 'bot:research', wasSending, sending, lastReadAt, now });
  }

  test('a turn that ends is a read — once', () => {
    expect(edge(true, false, undefined, 1_000)).toBe(true);
  });

  test('the read that just happened is recorded, so a re-mount is not a re-read', () => {
    expect(edge(false, false, 1_000, 1_500)).toBe(false);
    // Nothing marks a surface as read unless a read actually ran on it.
    expect(edge(false, false, undefined, 1_500)).toBe(false);
  });

  test('a turn STARTING is never a read, and neither is staying idle', () => {
    expect(edge(false, true, undefined, 1_000)).toBe(false);
    expect(edge(true, true, undefined, 1_000)).toBe(false);
    expect(edge(false, false, undefined, 1_000)).toBe(false);
  });

  test('two turns that end within the minimum gap read once, not twice', () => {
    // Turn one ends at t=0 against a surface last read long ago: it reads.
    expect(edge(true, false, 0 - 60_000, 0)).toBe(true);
    const lastReadAt = 0;
    // Turn two ends 3s later — inside the 10s floor, so it is DROPPED rather
    // than queued, and the glance stays on the total it already has.
    expect(edge(true, false, lastReadAt, 3_000)).toBe(false);
    // A third at 4s after that first read is still inside the floor.
    expect(edge(true, false, lastReadAt, 4_000)).toBe(false);
    // Once the floor has passed, a turn ending reads again.
    expect(edge(true, false, lastReadAt, lastReadAt + THREAD_SPEND_MIN_READ_MS)).toBe(true);
  });

  test('a roster or group room has no glance, so no turn is ever read for it', () => {
    expect(
      threadSpendFinishedRead({
        surfaceKey: undefined,
        wasSending: true,
        sending: false,
        lastReadAt: undefined,
        now: 0,
      }),
    ).toBe(false);
  });

  test('the floor is ten seconds', () => {
    expect(THREAD_SPEND_MIN_READ_MS).toBe(10_000);
  });

  test('chat-screen records the last read per surface and bumps a finish tick, not the retry tick', () => {
    expect(chatScreen).toContain('const [spendFinishTick, setSpendFinishTick] = useState(0);');
    expect(chatScreen).toContain('spendLastReadRef.current[spendSurfaceKey] = Date.now();');
    expect(chatScreen).toContain('lastReadAt: spendSurfaceKey ? spendLastReadRef.current[spendSurfaceKey] : undefined,');
    expect(chatScreen).toContain('spendWasSendingRef.current = isSending;');
    expect(chatScreen).toMatch(/\n    setSpendFinishTick\(\(tick\) => tick \+ 1\);/);
    // The finish tick rides the same key the manual Retry bump uses.
    expect(chatScreen).toContain('`${spendRefreshKey}:finish${spendFinishTick}:retry${spendRetryTick}`');
  });
});

describe('the glance asks for 50 rows, and 200 only when that misses the thread', () => {
  test('the narrow window is 50 and the wide one is the catalogue cap', () => {
    expect(THREAD_SPEND_GLANCE_LIMIT).toBe(50);
    expect(SESSION_SPEND_LIST_LIMIT).toBe(200);
  });

  test('the thread is in the newest 50 — no wide read', () => {
    const payload = { object: 'list', data: [row('s1'), ...Array.from({ length: 49 }, (_, i) => row(`old-${i}`))] };
    const read = sessionSpendReadFromUnknown(payload);
    expect(threadSpendNeedsWideRead(read, 's1')).toBe(false);
  });

  test('the thread is not in the newest 50 — one wide read is owed', () => {
    const payload = { object: 'list', data: Array.from({ length: 50 }, (_, i) => row(`other-${i}`)) };
    const read = sessionSpendReadFromUnknown(payload);
    expect(threadSpendNeedsWideRead(read, 's1')).toBe(true);
  });

  test('a failed or threadless read owes no wide read', () => {
    expect(threadSpendNeedsWideRead({ ok: false }, 's1')).toBe(false);
    expect(threadSpendNeedsWideRead(sessionSpendReadFromUnknown({ unexpected: 'envelope' }), 's1')).toBe(false);
    // No live session means there is no thread to look for.
    expect(threadSpendNeedsWideRead(sessionSpendReadFromUnknown({ data: [] }), undefined)).toBe(false);
  });

  test('the ladder the screen runs: a narrow read, and one wide read only for the miss', () => {
    // The whole effect body, so the ORDER is pinned and not just the helpers.
    const effect = chatScreen.match(/void gatewayRequest\('sessions\.list', \{ limit: THREAD_SPEND_GLANCE_LIMIT \}\)[\s\S]*?\n  \}, \[/)?.[0];
    expect(effect).toBeDefined();
    const narrow = effect!.indexOf('limit: THREAD_SPEND_GLANCE_LIMIT');
    const decide = effect!.indexOf('threadSpendNeedsWideRead(read, currentSessionId)');
    const wide = effect!.indexOf('limit: SESSION_SPEND_LIST_LIMIT');
    expect(narrow).toBeGreaterThan(-1);
    expect(decide).toBeGreaterThan(narrow);
    expect(wide).toBeGreaterThan(decide);
    // Exactly two reads in the whole effect: the narrow one and the single
    // fallback. A third would mean the glance had become a poll.
    expect(effect!.match(/gatewayRequest\('sessions\.list'/g)).toHaveLength(2);
  });

  test('a failed narrow read keeps the last good total rather than widening', () => {
    const previous = applySessionSpendRead(EMPTY_SESSION_SPEND, {
      ok: true,
      sessions: [row('s1', 150)],
      rowCount: 1,
    });
    expect(applySessionSpendRead(previous, { ok: false })).toEqual({
      sessions: previous.sessions,
      loaded: true,
      failed: true,
      rowCount: 1,
    });
  });
});

describe('leaving and re-entering a thread paints instantly', () => {
  test('the last glance answer is held per surface in memory', () => {
    expect(chatScreen).toContain('const spendGlanceRef = useRef<Record<string, SessionSpendRead>>({});');
    expect(chatScreen).toContain('if (read.ok) spendGlanceRef.current[spendSurfaceKey] = read;');
    // Painted before the network read of this effect runs.
    const effect = chatScreen.match(/const held = spendGlanceRef\.current\[spendSurfaceKey\];[\s\S]*?\n    void gatewayRequest\(/)?.[0];
    expect(effect).toBeDefined();
    expect(effect).toContain('if (held) applyRead(held);');
  });
});