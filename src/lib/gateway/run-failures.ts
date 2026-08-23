// ─── Desktop-parity failure states for bot sends and remote runs ──
//
// When a Bot send or a run fails, the Gate's error text reaches the phone
// verbatim (`messageFromHttpErrorBody` passes `error.message` through) and
// lands in a bubble as `Error: <raw text>` — true, and exactly as actionable
// as the desktop's raw stderr. A desktop operator fixes that from memory and
// a shell on the same machine; a phone operator has neither. These classifiers
// give the phone the verdict the desktop operator reaches by hand: WHAT state
// the host is in, and THE fix.
//
// Every pattern below is anchored to a string the Gate actually emits
// (gate/core/cli-environments/backends/hermes.mjs `forBot`, supervisor.mjs
// run failures), never to an invented wire shape. Unknown text classifies as
// 'generic' and every caller falls back to today's raw-text behavior — a
// misfire can only cost us the nicer wording, never the truth.

export type RunFailureKind =
  /** Multiplex off (ADR 0008): named-prefix chat fails until the host enables it. */
  | 'multiplex_disabled'
  /** The profile still carries the default listen key (ADR 0005). */
  | 'default_key_refused'
  /** The profile .env has no API_SERVER_KEY at all (ADR 0006). */
  | 'listen_key_missing'
  /** The roster names a Bot the host no longer has. */
  | 'unknown_bot'
  /** The CLI environment could not spawn or was never reachable. */
  | 'environment_unreachable'
  /** The run outlived its environment's lifecycle.maxRunSeconds budget. */
  | 'time_limit'
  /** The job/run's authorization window elapsed before it completed. */
  | 'expired'
  | 'generic';

/**
 * Classify a raw failure message from the Gate.
 *
 * Order matters: `bot "x" still uses the default listen key … give the
 * profile its own API_SERVER_KEY` mentions API_SERVER_KEY too, so the
 * missing-key pattern must stay specific (`has no`) and run first.
 */
export function classifyRunFailure(message: string): RunFailureKind {
  const text = message ?? '';
  if (/has no api_server_key/i.test(text)) return 'listen_key_missing';
  if (/default listen key|default_key_refused/i.test(text)) return 'default_key_refused';
  if (/multiplex/i.test(text)) return 'multiplex_disabled';
  if (/\bunknown bot\b/i.test(text)) return 'unknown_bot';
  if (/hermes home is not configured|cannot act as a chat backend|does not implement bots|no attached backend/i.test(
    text,
  )) {
    return 'environment_unreachable';
  }
  if (/exceeded its \d+s time limit|maxrunseconds|run time limit/i.test(text)) return 'time_limit';
  if (/before becoming reachable|workspace directory disappeared|\benoent\b|environment "[^"]*" not found/i.test(
    text,
  )) {
    return 'environment_unreachable';
  }
  if (/\bexpired\b/i.test(text)) return 'expired';
  return 'generic';
}

/** The operator-facing view of a classified failure. */
export type RunFailureView = {
  kind: RunFailureKind;
  /** Short verdict naming the host state, desktop-parity. */
  title: string;
  /** The original gateway text, kept verbatim — never paraphrased away. */
  cause: string;
  /** The fix, in operator language. Absent for generic failures. */
  next?: string;
};

const TITLES: Record<Exclude<RunFailureKind, 'generic'>, Pick<RunFailureView, 'title' | 'next'>> = {
  multiplex_disabled: {
    title: 'Multiplex is off',
    next: 'Enable multiplex on the host (set gateway.multiplex_profiles true), then retry.',
  },
  default_key_refused: {
    title: 'Bot listen key refused',
    next: "Give this profile its own API_SERVER_KEY — named Bots reject the default profile's key.",
  },
  listen_key_missing: {
    title: 'Bot has no listen key',
    next: "Set API_SERVER_KEY in the profile's .env on the host, then retry.",
  },
  unknown_bot: {
    title: 'Bot not found',
    next: 'Reload the roster — this Bot may have been removed or renamed on the host.',
  },
  environment_unreachable: {
    title: 'Environment unreachable',
    next: 'Check the CLI environment on the Gate machine (executable path, workspace), then retry.',
  },
  time_limit: {
    title: 'Task hit its time limit',
    next: 'Raise or remove lifecycle.maxRunSeconds on the environment, then resubmit.',
  },
  expired: {
    title: 'Task expired',
    next: 'Resubmit it — the host considers this job past its valid window.',
  },
};

/** Classify and render the full view in one call. */
export function describeRunFailure(message: string): RunFailureView {
  const cause = message ?? '';
  const kind = classifyRunFailure(cause);
  if (kind === 'generic') {
    // Same fallback verdict the error humanizer uses — present so the view
    // type stays complete; callers treat generic as "no improvement over raw".
    return { kind, title: 'Something went wrong', cause };
  }
  return { kind, ...TITLES[kind], cause };
}

/**
 * One-line prose form for surfaces that take a plain string (chat bubbles,
 * system notes). Returns null for generic failures so callers fall back to
 * the raw message instead of wrapping every error in boilerplate.
 *
 * Punctuation joins the way `describeGatewayError` does: no doubled periods,
 * a separator added only when the cause lacks one.
 */
export function formatRunFailure(message: string): string | null {
  const view = describeRunFailure(message);
  if (!view.next) return null;
  const separator = /[.!?]$/.test(view.cause.trim()) ? ' ' : '. ';
  return `${view.title} — ${view.cause}${separator}${view.next}`;
}
