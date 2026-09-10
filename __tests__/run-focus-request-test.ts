// A run notice's tap names the run it settled, and the Activity list can be
// filtered to another Bot when the tap lands (the Scorecards tap leaves the
// tab's filter set). This pins the fold that decides what the pending request
// becomes — the seam the tab consumes and clears.

import { pendingRunFocus, type RunFocus } from '@/lib/notifications/run-focus';

describe('pendingRunFocus (the run a tap asked the list to show)', () => {
  const runA: RunFocus = { runId: 'run-a' };
  const runB: RunFocus = { runId: 'run-b' };

  test('nothing pending takes the request', () => {
    expect(pendingRunFocus(null, runA)).toBe(runA);
  });

  test('the run already pending is the same request, not a fresh one', () => {
    // The tab's effect keys on this value, and a fresh object would re-apply a
    // focus the tab is already applying — a repeated tap must change nothing.
    const repeat = { runId: 'run-a' };
    expect(repeat).not.toBe(runA);
    expect(pendingRunFocus(runA, repeat)).toBe(runA);
  });

  test('a different run replaces what was pending', () => {
    // The tap that arrived last is the run the notice was about, and the tab
    // has not applied the first one yet.
    expect(pendingRunFocus(runA, runB)).toBe(runB);
  });
});
