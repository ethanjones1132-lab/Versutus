// ─── Activity sheet job controls: Run now + Pause/Resume ──
//
// The Activity tab shows every scheduled job on the gateway, including a
// Bot-owned Routine the sheet itself labels. The Bot Routines pane already
// drives Run now row-tap-to-run and Pause/Resume through the gateway client;
// this is the same pair for the gateway-level sheet, kept pure so the sheet
// stays dumb and testable.
//
// A refused call names the failure and keeps the last good pause state —
// exactly the sheet's runs-error discipline — so a failed Pause never flips
// the label to a state the host did not take.
import type { CronJob } from './cron';
import { describeRoutineError } from './routines';

/** A paused job offers Resume; everything else offers Pause. */
export function cronJobPauseLabel(job: Pick<CronJob, 'paused'>): string {
  return job.paused ? 'Resume' : 'Pause';
}

/**
 * Operator-facing text for a refused Run now, Pause, or Resume. Failures the
 * run-failure classifiers know render the same verdict + fix the Routines
 * pane shows; anything unclassifiable stays the raw message.
 */
export function describeCronJobControlError(cause: unknown): string {
  return describeRoutineError(cause);
}
