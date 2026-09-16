// A run notice's tap names the run it settled, and the Runs destination
// applies the focus itself: the Bot filter is dropped so the run's row is
// visible, and the row is then highlighted. This pins the highlight fold —
// which row glows, and which nothing may guess.

import { focusedRunItemId, type RunListItem } from '@/lib/notifications/run-list-focus';
import type { ActivityRun } from '@/lib/gateway/runs';

/** Rows keyed exactly as the Runs list keys them, with stubbed run rows. */
const STUB_RUN = { prompt: '', startedAt: 0, events: [] };

function rows(runs: { id: string; status: ActivityRun['status'] }[]): RunListItem[] {
  const items: RunListItem[] = [{ kind: 'label', id: 'in-flight', text: 'In flight' }];
  for (const run of runs) {
    const stubbed: ActivityRun = { ...STUB_RUN, ...run };
    items.push(
      run.status === 'running' || run.status === 'waiting-approval'
        ? { kind: 'active', id: run.id, run: stubbed }
        : { kind: 'finished', id: run.id, run: stubbed },
    );
  }
  return items;
}

describe('focusedRunItemId (the row a run tap highlighted)', () => {
  const items = rows([
    { id: 'run-a', status: 'running' },
    { id: 'run-b', status: 'complete' },
  ]);

  test('an in-flight run names its own row', () => {
    expect(focusedRunItemId(items, { runId: 'run-a' })).toBe('run-a');
  });

  test('a finished run names its own row', () => {
    expect(focusedRunItemId(items, { runId: 'run-b' })).toBe('run-b');
  });

  test('a run this device does not hold highlights nothing', () => {
    // The tap must not guess the nearest row, and never highlight a section
    // label: a missing id means NO highlight, not the wrong one.
    expect(focusedRunItemId(items, { runId: 'run-z' })).toBeNull();
  });

  test('an empty list highlights nothing', () => {
    expect(focusedRunItemId([], { runId: 'run-a' })).toBeNull();
  });
});
