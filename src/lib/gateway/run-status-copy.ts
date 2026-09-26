import type { ActivityRun } from '@/lib/gateway/runs';

/** The semantic colour a run's status line wears. Never a brand colour. */
export type RunStatusTone = 'live' | 'attention' | 'done' | 'failed' | 'quiet';

/**
 * One run's status in the operator's words, for a compact row: what is
 * happening, and whether it needs them. "Waiting for you" is the one line
 * that asks for something, so it is the one that wears the attention tone.
 */
export function runStatusCopy(status: ActivityRun['status']): { label: string; tone: RunStatusTone } {
  switch (status) {
    case 'running':
      return { label: 'Working', tone: 'live' };
    case 'waiting-approval':
      return { label: 'Waiting for you', tone: 'attention' };
    case 'complete':
      return { label: 'Done', tone: 'done' };
    case 'failed':
      return { label: 'Failed', tone: 'failed' };
    case 'cancelled':
      return { label: 'Stopped', tone: 'quiet' };
    default:
      return { label: 'Outcome unknown', tone: 'quiet' };
  }
}

/**
 * The runs a glance should show first: anything waiting on the operator,
 * then anything still working, then the newest finished — capped.
 */
export function runsForGlance(runs: ActivityRun[], limit: number): ActivityRun[] {
  const rank = (run: ActivityRun) =>
    run.status === 'waiting-approval' ? 0 : run.status === 'running' ? 1 : 2;
  return [...runs]
    .sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt)
    .slice(0, Math.max(0, limit));
}
