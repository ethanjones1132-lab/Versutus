// ─── Pure decision helper for a notification tap (FUTURE-ITEMS.md §1c) ────
// Free of expo-notifications calls, so every routing rule is jest-pinnable
// without mocks. The only imports are the notice markers, which pull
// expo-notifications for their trigger-type constants alone. The response
// listener in src/app/_layout.tsx reads the response's data payload and
// applies this decision to the router.
//
// Before this module every tap landed on Activity. A tap now routes on the
// payload's `kind`; a payload that is absent, half-shaped, or names a kind
// this sprint does not route still lands on Activity, exactly as before.

import { ROUTINE_NOTICE_DATA_KIND } from './routine-schedule';
import { WEEKLY_REPORT_NOTICE_DATA_KIND } from './weekly-report-schedule';

/** data.kind marker a run notice carries, so a tap knows the run. */
export const RUN_NOTICE_DATA_KIND = 'run';

/**
 * Where a notification payload asks a tap to go. The ids travel with the
 * route so the screen that opens can name the exact routine or run; they are
 * the same ids the relay must supply once true push ships (Solution A5).
 * A weekly report carries none: its destination takes no argument, because
 * the Scorecards section reads this device's runs when it opens.
 */
export type TapRoute =
  | { kind: 'routine'; jobId: string; botId: string }
  | { kind: 'run'; runId: string }
  | { kind: 'weekly-report' };

/**
 * The route a notification tap asks for, or null when the payload is absent
 * or unrecognized — null means the caller's Activity fallback.
 *
 * A `kind` names the destination, but the ids it needs must be present: a
 * routine notice without its jobId cannot open a routine, and a run notice
 * without its runId cannot name a run. A half-shaped payload is unrecognized,
 * not a half-route — never guess an id.
 */
export function routeForTap(data: unknown): TapRoute | null {
  if (!data || typeof data !== 'object') return null;
  const payload = data as Record<string, unknown>;

  if (payload.kind === ROUTINE_NOTICE_DATA_KIND) {
    const jobId = nonEmptyString(payload.jobId);
    const botId = nonEmptyString(payload.botId);
    if (!jobId || !botId) return null;
    return { kind: 'routine', jobId, botId };
  }

  if (payload.kind === RUN_NOTICE_DATA_KIND) {
    const runId = nonEmptyString(payload.runId);
    if (!runId) return null;
    return { kind: 'run', runId };
  }

  // A weekly report notice is only its kind: the tap opens the scorecard
  // surface, which needs no id because it reads this device's runs itself.
  // Any keys a push relay later adds ride along unread (Solution A5).
  if (payload.kind === WEEKLY_REPORT_NOTICE_DATA_KIND) return { kind: 'weekly-report' };

  return null;
}

/** A present, non-empty string id — anything else is not an id. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
