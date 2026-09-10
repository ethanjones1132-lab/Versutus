import { buildHomeBriefing } from '@/lib/home/briefing';
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
