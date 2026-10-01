jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
}));

import { buildHomeBriefing, homeBriefingSummary } from '@/lib/home/briefing';
import { settleUnresolvedRuns } from '@/lib/gateway/runs';
import { normalizeRestoredRuns } from '@/lib/gateway/session-persistence';
import type { ActivityRun } from '@/lib/gateway/runs';

const LAST_SEEN = 1757400000000;

function run(overrides: Partial<ActivityRun> = {}): ActivityRun {
  return {
    id: 'run-1',
    prompt: 'do the thing',
    status: 'complete',
    startedAt: LAST_SEEN - 60_000,
    finishedAt: LAST_SEEN + 60_000,
    events: [],
    ...overrides,
  };
}

describe('buildHomeBriefing', () => {
  test('has no window without a stamp — empty, never guessed', () => {
    expect(buildHomeBriefing([run()], null, LAST_SEEN + 120_000)).toBeNull();
  });

  test('is empty when every run predates the visit', () => {
    const earlier = run({ finishedAt: LAST_SEEN - 1_000 });
    const briefing = buildHomeBriefing([earlier], LAST_SEEN, LAST_SEEN + 120_000)!;
    expect(briefing.finished.complete).toHaveLength(0);
    expect(briefing.finished.failed).toHaveLength(0);
    expect(briefing.finished.unresolved).toHaveLength(0);
    expect(briefing.live).toHaveLength(0);
    expect(briefing.pendingApprovals).toBe(0);
  });

  test('groups what finished after the operator left', () => {
    const briefing = buildHomeBriefing(
      [
        run({ id: 'a', status: 'complete' }),
        run({ id: 'b', status: 'failed', finishedAt: LAST_SEEN + 90_000 }),
        run({ id: 'c', status: 'unresolved', finishedAt: LAST_SEEN + 120_000 }),
      ],
      LAST_SEEN,
    )!;
    expect(briefing.finished.complete.map((r) => r.id)).toEqual(['a']);
    expect(briefing.finished.failed.map((r) => r.id)).toEqual(['b']);
    expect(briefing.finished.unresolved.map((r) => r.id)).toEqual(['c']);
  });

  test('counts a run that finished mid-flight as news even when it started before the leave', () => {
    const briefing = buildHomeBriefing(
      [run({ startedAt: LAST_SEEN - 500_000 })],
      LAST_SEEN,
    )!;
    expect(briefing.finished.complete).toHaveLength(1);
  });

  test('carries over a run still alive rather than calling it finished', () => {
    const briefing = buildHomeBriefing(
      [
        run({ id: 'live', status: 'running', finishedAt: undefined }),
        run({
          id: 'stuck',
          status: 'waiting-approval',
          finishedAt: undefined,
        }),
      ],
      LAST_SEEN,
    )!;
    expect(briefing.live.map((r) => r.id).sort()).toEqual(['live', 'stuck']);
    expect(briefing.finished.complete).toHaveLength(0);
    expect(briefing.pendingApprovals).toBe(1);
  });

  test('counts approvals only for waiting-approval runs', () => {
    const briefing = buildHomeBriefing(
      [run({ id: 'ok', status: 'complete' }), run({ id: 'stuck', status: 'waiting-approval', finishedAt: undefined })],
      LAST_SEEN,
    )!;
    expect(briefing.pendingApprovals).toBe(1);
  });

  test('never presents a finish timestamp from the future as overdue', () => {
    const briefing = buildHomeBriefing(
      [run({ status: 'unresolved', finishedAt: LAST_SEEN + 500_000 })],
      LAST_SEEN,
      LAST_SEEN + 120_000,
    )!;
    expect(briefing.finished.unresolved).toHaveLength(0);
    expect(briefing.live).toHaveLength(0);
  });

  test('ends a cancelled run in the failed group — it did not finish well', () => {
    const briefing = buildHomeBriefing([run({ status: 'cancelled' })], LAST_SEEN)!;
    expect(briefing.finished.failed.map((r) => r.id)).toEqual(['run-1']);
  });

  test('carries over a restored run whose fate was never learned — still going, not news', () => {
    // What `normalizeRestoredRuns` hands back after the app closed under a
    // run: `unresolved` with no finish of its own. The gateway may still be
    // executing it, so it is live until a settle re-poll learns a real end.
    const restored = normalizeRestoredRuns([run({ id: 'restored', status: 'running', finishedAt: undefined })]);
    const briefing = buildHomeBriefing(restored, LAST_SEEN, LAST_SEEN + 120_000)!;

    expect(restored[0].finishedAt).toBeUndefined();
    expect(briefing.live.map((r) => r.id)).toEqual(['restored']);
    expect(briefing.finished.unresolved).toHaveLength(0);
    expect(briefing.finished.failed).toHaveLength(0);
    expect(homeBriefingSummary(briefing).lines).toEqual(['1 run still going']);
  });

  test('a local- provisional restores cancelled, so it reads as a run that ended', () => {
    const restored = normalizeRestoredRuns([
      run({ id: 'local-1234-abcd', status: 'running', finishedAt: undefined }),
    ]);
    // `now` is this device's own clock: the restore stamps the load, so a fixed
    // test clock would place that stamp in the future and read as a placeholder.
    const briefing = buildHomeBriefing(restored, LAST_SEEN, Date.now())!;

    expect(restored[0].finishedAt).toEqual(expect.any(Number));
    expect(briefing.live).toHaveLength(0);
    expect(briefing.finished.failed.map((r) => r.id)).toEqual(['local-1234-abcd']);
  });

  test('a settle re-poll that confirms a real end turns the same run into news', async () => {
    const restored = normalizeRestoredRuns([
      run({ id: 'restored', status: 'running', finishedAt: undefined }),
    ]);

    // Until the settle has spoken the digest must not report an end for it.
    const before = buildHomeBriefing(restored, LAST_SEEN, LAST_SEEN + 120_000)!;
    expect(before.live.map((r) => r.id)).toEqual(['restored']);

    const { runs, changed } = await settleUnresolvedRuns(
      { getRunStatus: async () => ({ run_id: 'restored', status: 'complete', result: 'done' }) },
      restored,
    );
    const settledAt = runs[0].finishedAt!;
    const briefing = buildHomeBriefing(runs, LAST_SEEN, settledAt)!;

    expect(changed.map((r) => r.id)).toEqual(['restored']);
    expect(briefing.live).toHaveLength(0);
    expect(briefing.finished.complete.map((r) => r.id)).toEqual(['restored']);
  });

  test('an unresolved run with a real finish of its own is ended-without-a-result news', () => {
    // The shape a settle that could not confirm an end leaves behind: still
    // `unresolved`, but stamped when the device learned the run was over
    // (`gateway-provider.tsx` patches status and finishedAt together).
    const briefing = buildHomeBriefing(
      [run({ id: 'unwatched', status: 'unresolved', finishedAt: LAST_SEEN + 30_000 })],
      LAST_SEEN,
      LAST_SEEN + 120_000,
    )!;

    expect(briefing.live).toHaveLength(0);
    expect(briefing.finished.unresolved.map((r) => r.id)).toEqual(['unwatched']);
    expect(homeBriefingSummary(briefing).lines).toContain('1 run ended without a result');
  });

  test('finishes count newest first', () => {
    const briefing = buildHomeBriefing(
      [
        run({ id: 'old', finishedAt: LAST_SEEN + 10_000 }),
        run({ id: 'new', finishedAt: LAST_SEEN + 30_000 }),
      ],
      LAST_SEEN,
    )!;
    expect(briefing.finished.complete.map((r) => r.id)).toEqual(['new', 'old']);
  });
});
