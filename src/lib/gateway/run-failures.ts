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
  /** A removal named a member the host's copy of the room doesn't carry. */
  | 'unknown_member'
  /** The Gate could not read its bot list while verifying group members. */
  | 'roster_unavailable'
  /** The CLI environment could not spawn or was never reachable. */
  | 'environment_unreachable'
  /** The run outlived its environment's lifecycle.maxRunSeconds budget. */
  | 'time_limit'
  /** The job/run's authorization window elapsed before it completed. */
  | 'expired'
  /** A finished run's event stream cannot be replayed — the Gate has no archive for it. */
  | 'run_events_unavailable'
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
  // The Gate's own code for a replay miss (d1acb9d): the run-events route
  // answers 404 {error:{code:'run_events_unavailable'}} and the clients
  // prefix it. Anchored on the code, which dominates whatever the upstream
  // said — the reason text may itself name a state this classifier knows.
  if (/run_events_unavailable\b/i.test(text)) return 'run_events_unavailable';
  if (/default listen key|default_key_refused/i.test(text)) return 'default_key_refused';
  if (/multiplex/i.test(text)) return 'multiplex_disabled';
  if (/\bunknown bots?\b/i.test(text)) return 'unknown_bot';
  // gate/core/cli-environments/bot-groups.mjs leave(): a removal naming a
  // member the host's copy of the room does not carry — 404 with code
  // unknown_member, body message passed through verbatim. Typically a stale
  // phone view: another device removed them first. Anchored on both the
  // sentence and the code shape, like run_events_unavailable above.
  if (/member not in group|unknown_member\b/i.test(text)) return 'unknown_member';
  // Refused pre-start probe: the supervisor throws `environment <state>` and,
  // since the desktop-parity audit, appends the probe's reason + path. The
  // busy refusal ("environment is busy — …") deliberately does NOT match.
  if (/environment (?:not_installed|incompatible|degraded)\b/i.test(text)) {
    return 'environment_unreachable';
  }
  // gate/core/cli-environments/backends/hermes.mjs (:521/:600) throws
  // `Hermes executable or home is not configured` when either half of the
  // CLI environment is missing; older surfaces emit the same refusal without
  // the executable clause. Both wordings are one verdict.
  if (
    /hermes (?:executable or )?home is not configured|cannot act as a chat backend|does not implement bots|no attached backend/i.test(
      text,
    )
  ) {
    return 'environment_unreachable';
  }
  if (/exceeded its \d+s time limit|maxrunseconds|run time limit/i.test(text)) return 'time_limit';
  if (/before becoming reachable|workspace directory disappeared|\benoent\b|environment "[^"]*" not found/i.test(
    text,
  )) {
    return 'environment_unreachable';
  }
  // gate/core/cli-environments/bot-groups.mjs membership writes: the fronted
  // listBots read failed (`roster_unavailable`, 502) so members could not be
  // verified. Checked LATE on purpose — the embedded cause often names a
  // state above (an unconfigured CLI environment), and that verdict wins.
  if (/cannot verify group members/i.test(text)) return 'roster_unavailable';
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
  unknown_member: {
    title: 'Bot not in this room',
    next: "Reload the room to see the host's current members — another device may have removed it already.",
  },
  roster_unavailable: {
    title: 'Roster unreadable',
    next: 'The Gate could not read its bot list to verify these members — check the CLI environment on the Gate machine, then retry.',
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
  run_events_unavailable: {
    title: 'Replay unavailable',
    next: 'The Gate has no archived stream for this run, so its output cannot be replayed. Its status and result still show in Recent runs — run it again from there to see output.',
  },
};

/**
 * Routing-state verdicts share the run-failure vocabulary: "no listen key"
 * and "default key refused" are the same host states whether the Gate
 * reported them as a send failure or as roster routing state, so both
 * surfaces must show the same title and the same fix. Kept here — not
 * re-declared by callers — so the strings stay pinned in one place.
 */
export function routingFailureView(
  kind: Extract<RunFailureKind, 'listen_key_missing' | 'multiplex_disabled' | 'default_key_refused'>,
): Pick<RunFailureView, 'title' | 'next'> {
  return TITLES[kind];
}

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

/** What the Gate reports about a turn's model, once it resolves. */
export type ModelReport = {
  /** The model that was asked for. */
  requested?: string;
  /** The model that actually served the turn. */
  ran?: string;
  /** The provider that served it, when reported. */
  provider?: string;
};

/**
 * The honest account of a turn that was answered by a model the operator did
 * not choose, or null when nothing can be claimed.
 *
 * Backends substitute. Hermes falls through `fallback_providers` whenever the
 * requested model refuses — and, observed 2026-08-24, keeps doing it for the
 * rest of the process once one unsupported-model 401 marks the primary
 * provider's credential pool exhausted. It reports the swap; the app used to
 * show the operator's own pick regardless, so a LongCat conversation answered
 * by something else looked exactly like a LongCat conversation.
 *
 * Null in all three honest cases: the names match, or either name is missing.
 * A gateway that cannot say what ran leaves the question open — it must never
 * be dressed up as confirmation.
 */
export function describeModelSubstitution(report: ModelReport): RunFailureView | null {
  const requested = report.requested?.trim();
  const ran = report.ran?.trim();
  if (!requested || !ran) return null;
  if (requested.toLowerCase() === ran.toLowerCase()) return null;
  const servedBy = report.provider?.trim() ? `${report.provider.trim()}/${ran}` : ran;
  return {
    kind: 'generic',
    title: 'A different model answered',
    cause: `You chose ${requested}; ${servedBy} replied.`,
    next: 'Check the gateway\'s fallback_providers — a thread also keeps the model it was opened with, which is why changing model starts a fresh session.',
  };
}

/**
 * One line for the transcript when a turn was answered by a model the
 * operator did not choose, or null when there is nothing to report.
 *
 * Joined the way `formatRunFailure` joins — no doubled punctuation — because
 * it lands in the same system-note channel. Null means silence: a gateway
 * that cannot say what ran gets no reassuring line either.
 */
export function modelSubstitutionNote(report: ModelReport): string | null {
  const view = describeModelSubstitution(report);
  if (!view?.next) return null;
  const separator = /[.!?]$/.test(view.cause.trim()) ? ' ' : '. ';
  return `${view.title} — ${view.cause}${separator}${view.next}`;
}

/**
 * Suppress the identical substitution note on consecutive turns.
 *
 * A gateway with `fallback_providers` can substitute the same
 * requested→ran pair on every turn in a row; each one is correctly
 * detected by `describeModelSubstitution`, but repeating the same line
 * verbatim fills the transcript with noise. This is the dedup gate:
 * the first occurrence shows, an identical immediate repeat is silent,
 * and a changed pair shows again.
 *
 * Pure — the caller owns the memory of what it last reported.
 * Comparison is case-insensitive and trims surrounding whitespace,
 * matching `describeModelSubstitution`, so `" LongCat "` and
 * `"longcat"` are the same pair.
 */
export function shouldShowModelSubstitution(
  report: ModelReport,
  previous: ModelReport | null | undefined,
): boolean {
  // Nothing to report is not a repeat — it is silence controlled by
  // describeModelSubstitution, so dedup has nothing to suppress.
  if (!describeModelSubstitution(report)) return false;
  if (!previous) return true;
  if (!describeModelSubstitution(previous)) return true;
  const norm = (value: string | undefined) => (value ?? '').trim().toLowerCase();
  return !(norm(report.requested) === norm(previous.requested) && norm(report.ran) === norm(previous.ran));
}
