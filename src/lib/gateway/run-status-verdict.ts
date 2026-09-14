/**
 * `/run`'s status classification, shared instead of re-guessed.
 *
 * `runTaskCommand` (slash-commands.ts) decided "Run complete" from a
 * hardcoded status regex, while the reducer that produced the outcome
 * already carries `outcomeToActivityStatus` — the real mapping that keeps
 * `unresolved` distinct from every terminal verdict. This module folds the
 * outcome onto the Activity tab's own verdict vocabulary so a run that never
 * reached a terminal state is never presented as finished, and a failed run
 * reads the verdict the Activity tab folds rather than a second English
 * guess at what "done" sounds like.
 */

import {
  outcomeToActivityStatus,
  type RunOutcome,
} from '@/lib/gateway/runs';

/** The Activity tab's terminal verdicts the /run line can read verbatim. */
const TERMINAL_ACTIVITY_STATUS = new Set(['complete', 'failed', 'cancelled']);

/**
 * The word the /run verdict line reads for this outcome: "Run complete" when
 * the Activity verdict is complete, the terminal verdict verbatim when the
 * run finished any other way, and the run's own newest status for a run that
 * never settled — the honest "Run <status>" fallback, never re-worded into a
 * finished verdict.
 */
export function runSlashStatusWord(outcome: RunOutcome): string {
  const status = outcomeToActivityStatus(outcome);
  if (status === 'complete' || status === 'cancelled') return status;
  if (TERMINAL_ACTIVITY_STATUS.has(status)) return status;
  return outcome.status;
}
