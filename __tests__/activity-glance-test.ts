import { DAY_MS, RIBBON_TICKS, dayRibbon, glanceFigures, ribbonPosition } from '@/lib/activity/glance';
import type { ActivityRun } from '@/lib/gateway/runs';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

function run(id: string, status: ActivityRun['status'], agoMs: number, extra: Partial<ActivityRun> = {}): ActivityRun {
  return { id, prompt: id, status, startedAt: NOW - agoMs, events: [], ...extra };
}

describe('the glance figures', () => {
  test('needs you is the inbox count; working and done today come from the runs', () => {
    const runs = [
      run('a', 'running', 5 * 60_000),
      run('b', 'waiting-approval', 40 * 60_000),
      run('c', 'complete', 9 * HOUR, { finishedAt: NOW - 8 * HOUR }),
      run('d', 'complete', 30 * HOUR, { finishedAt: NOW - 29 * HOUR }),
    ];
    expect(glanceFigures(1, runs, NOW).map((f) => [f.key, f.value])).toEqual([
      ['needs-you', 1],
      ['working', 1],
      ['done', 1],
    ]);
  });

  test('a waiting run is not counted twice — the inbox already carries it', () => {
    expect(glanceFigures(0, [run('b', 'waiting-approval', 60_000)], NOW)[0].value).toBe(0);
  });

  test('failed appears only on a day something failed', () => {
    expect(glanceFigures(0, [], NOW).map((f) => f.key)).not.toContain('failed');
    const failed = glanceFigures(0, [run('x', 'failed', HOUR, { finishedAt: NOW - HOUR })], NOW);
    expect(failed.at(-1)).toEqual({ key: 'failed', value: 1, label: 'failed' });
  });
});

describe('the day ribbon', () => {
  test('is in perspective: now at the right, a day ago at the left, six hours at the middle', () => {
    expect(ribbonPosition(0)).toBe(1);
    expect(ribbonPosition(DAY_MS)).toBe(0);
    expect(ribbonPosition(6 * HOUR)).toBeCloseTo(0.5, 12);
    expect(ribbonPosition(-HOUR)).toBe(1); // a skewed clock sits at now
    expect(RIBBON_TICKS.map((t) => t.label)).toEqual(['6h', '1h']);
  });

  test('recent runs get room instead of piling up at now', () => {
    const recent = ribbonPosition(3 * 60_000) - ribbonPosition(38 * 60_000);
    expect(recent).toBeGreaterThan(0.1); // a tenth of the line apart, not a pixel
  });

  test('a restored run whose fate this device never learned counts as working', () => {
    // `unresolved` with no finish of its own: the gateway may still be running
    // it, so it belongs in "working", not in "done today" and not in "failed".
    const restored = run('restored', 'unresolved', 5 * 60_000, { finishedAt: undefined });
    const figures = glanceFigures(0, [restored], NOW);
    expect(figures.find((figure) => figure.key === 'working')?.value).toBe(1);
    expect(figures.find((figure) => figure.key === 'done')?.value).toBe(0);
    expect(figures.some((figure) => figure.key === 'failed')).toBe(false);
    // And the ribbon draws it live rather than as a dim settled bead.
    expect(dayRibbon([restored], NOW)[0].state).toBe('working');
  });

  test('only the run with no real finish counts as working beside one the settle finished', () => {
    // Both rows are `unresolved`; only the finish the settle re-poll learned
    // separates an in-flight row from an ended one, so the rule has to read
    // `finishedAt` and not the status.
    const restored = run('restored', 'unresolved', 5 * 60_000, { finishedAt: undefined });
    const settled = run('settled', 'unresolved', 4 * 60_000, { finishedAt: NOW - 60_000 });
    const figures = glanceFigures(0, [restored, settled], NOW);
    expect(figures.find((figure) => figure.key === 'working')?.value).toBe(1);
    // The one that really ended draws as the dim settled bead it is.
    expect(dayRibbon([restored, settled], NOW).map((bead) => [bead.id, bead.state])).toEqual([
      ['restored', 'working'],
      ['settled', 'settled'],
    ]);
  });

  test('beads are the last day of runs, oldest first, each marked by what it needs', () => {
    const beads = dayRibbon(
      [
        run('late', 'running', 3 * 60_000, { botId: 'ledger' }),
        run('old', 'complete', 30 * HOUR),
        run('wait', 'waiting-approval', 38 * 60_000, { botId: 'forge' }),
        run('early', 'complete', 20 * HOUR),
      ],
      NOW,
    );
    expect(beads.map((b) => [b.id, b.state])).toEqual([
      ['early', 'settled'],
      ['wait', 'waiting'],
      ['late', 'working'],
    ]);
    expect(beads[1].botId).toBe('forge');
  });
});
