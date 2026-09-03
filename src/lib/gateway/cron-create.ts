// ─── Activity gateway-level job create ──
//
// The Activity tab lists every scheduled job on the gateway, but until now
// could never add one: the only create path was the Bot Routines pane, which
// prefixes the title (`routineName`) and posts Bot-scoped. A gateway-level
// job is POST /v1/jobs with no bot scope
// (`gate/core/server.mjs`, `resolveBackendFor('createJob')`), which is what
// `ManifestClient.createJob` sends when the shared client names no Bot
// (`withBotOnly` returns the bare path, no `bot` in the body).
//
// So this surface reuses the Routines pane's draft fields and fail-honest
// discipline (`applyRoutineCreate`: only a confirmed create may clear the
// draft, a refusal keeps it and names why) against the existing job client —
// no new protocol, no provider change. The title stays unprefixed on purpose:
// prefixing it would file the job as one Bot's Routine instead of a
// gateway-level job.
import { DEFAULT_ROUTINE_SCHEDULE, type RoutineDraft } from './routines';

/** Body for the gateway-level POST /v1/jobs behind `botJobs.create`. */
export type GatewayJobInput = {
  name: string;
  prompt: string;
  schedule: string;
};

/**
 * Trimmed draft fields to the gateway-level job body. The name is the raw
 * title — never `[bot:…]`-prefixed — and a blank schedule falls back to the
 * same default the Routines pane offers.
 */
export function gatewayJobInput(draft: RoutineDraft): GatewayJobInput {
  return {
    name: draft.title.trim(),
    prompt: draft.prompt.trim(),
    schedule: draft.schedule.trim() || DEFAULT_ROUTINE_SCHEDULE,
  };
}

/**
 * A create may only be sent with a title and a prompt, mirroring the
 * Routines pane's Add guard.
 */
export function canCreateGatewayJob(draft: RoutineDraft): boolean {
  return draft.title.trim().length > 0 && draft.prompt.trim().length > 0;
}
