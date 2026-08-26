import { formatRunFailure } from './run-failures';

export function routineName(botId: string, title: string): string {
  const trimmed = title.trim();
  return `[bot:${botId}] ${trimmed}`;
}

export function parseRoutineName(name: string): { botId?: string; title: string } {
  const match = /^\[bot:([^\]]+)\]\s*(.*)$/.exec(name ?? '');
  if (!match) return { title: name ?? '' };
  return { botId: match[1], title: match[2] };
}

export type RoutineDraft = {
  title: string;
  prompt: string;
  schedule: string;
};

export const DEFAULT_ROUTINE_SCHEDULE = '0 9 * * *';

/**
 * Operator-facing text for a refused routine create, run, or pause. A
 * failure the run-failure classifiers know renders the same verdict + fix
 * every other surface shows; anything unclassifiable stays the raw message
 * — a misfire can only cost us the nicer wording, never the truth.
 */
export function describeRoutineError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return formatRunFailure(message) ?? message;
}

/**
 * After a create attempt: only a successful create may empty the title and
 * prompt. A refusal keeps the submitted fields so the operator can fix and
 * retry, and names why. Schedule stays either way — the pane already kept
 * it on success.
 */
export function applyRoutineCreate(
  submitted: RoutineDraft,
  mutation: { ok: true } | { ok: false; cause: unknown },
): { draft: RoutineDraft; error?: string } {
  if (mutation.ok) {
    return { draft: { title: '', prompt: '', schedule: submitted.schedule } };
  }
  return { draft: submitted, error: describeRoutineError(mutation.cause) };
}
