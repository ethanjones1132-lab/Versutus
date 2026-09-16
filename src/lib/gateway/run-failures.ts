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

import { sameModelId } from '@/lib/gateway/model-selection';

/**
 * A recorded failure of a pinned model, kept on the device against the
 * profile that pinned it.
 */
export type ModelTurnLock = {
  /** The qualified pin the failed turn was sent with. */
  model: string;
  /** The upstream refusal text, verbatim. */
  reason: string;
  /** When this device recorded the failure (epoch ms). */
  recordedAt: number;
  /** The profile that pinned it, when the caller knew one. */
  profileId?: string;
};

/**
 * The whole-message shape a Hermes host answers an unusable model with
 * (Hermes API-server chat path, reproduced 2026-09-16 via POST
 * /v1/chat/completions). Only a message that IS this shape is a refusal —
 * a real reply that merely MENTIONS "HTTP 400" stays a reply.
 */
export function upstreamModelRefusal(message: string | undefined | null): string | null {
  const text = message?.trim() ?? '';
  const match = text.match(/^HTTP \d{3}: .+$/i);
  return match ? text : null;
}

/** The model a failed turn was sent with, when the caller knows it. */
export type ModelTurnContext = {
  model?: string;
  profileId?: string;
};

/**
 * Record (or drop) the on-device lock a failed turn earns.
 *
 * The catalogue's `available` flag only reflects the provider's sign-in and
 * the picker's own gate; a model ·marked· available can still fail every
 * turn (2026-09-16: `omen-alpha` listed under the wrong provider id in a
 * Bot's catalogue, `available: true`, every chat 400'd). After a turn
 * returns the whole-message upstream refusal for a pinned model, keep that
 * verdict on the device: the picker then shows the row locked with its
 * reason, and the stale-pin fold can fall back from it.
 *
 * `answered` (a turn on the same model completing) clears the lock — the
 * operator re-pinned after the host gained the provider, and the model
 * clearly CAN answer here. This keeps `recordModelTurnFailure` and the
 * answer path the same pure fold: a lock can only be earned by a failure
 * and dropped by an answer or a clear, never by guessing.
 */
export function recordModelTurnFailure(
  locks: Record<string, ModelTurnLock> | undefined,
  turn: { raw?: string; answered?: boolean },
  context: ModelTurnContext = {},
): Record<string, ModelTurnLock> {
  const model = context.model?.trim();
  if (turn.answered === true && model) {
    if (!locks?.[model]) return locks ?? {};
    const next = { ...locks };
    delete next[model];
    return next;
  }
  const reason = upstreamModelRefusal(turn.raw);
  if (!reason || !model) return locks ?? {};
  const existing = locks?.[model];
  if (existing) return locks ?? {};
  return {
    ...(locks ?? {}),
    [model]: { model, reason, recordedAt: Date.now(), profileId: context.profileId },
  };
}

/**
 * Pick the first visible, unlocked model as a fallback for a pinned one.
 * Pure — the caller passes whatever rows it has and decides whether to apply.
 */
export function modelLockFallback(
  rows: readonly { id: string; available?: boolean; modelLocks?: Record<string, ModelTurnLock> }[],
  pinned: string | undefined,
): string | undefined {
  if (!pinned) return undefined;
  return rows.find(
    (row) =>
      row.available !== false &&
      !isModelLocked(row.modelLocks ?? {}, row.id) &&
      !sameModelId(row.id, pinned),
  )?.id;
}

/**
 * The picker consults locks BEFORE catalogue availability, so the picker's
 * cheap sign-in gate never hides a model that carries a recorded turn
 * failure on this device.
 */
export function isModelLocked(
  locks: Record<string, ModelTurnLock> | null | undefined,
  modelId: string | null | undefined,
): boolean {
  if (!modelId) return false;
  const key = modelId.trim();
  if (!key) return false;
  if (locks?.[key]) return true;
  return Object.keys(locks ?? {}).some((locked) => sameModelId(locked, key));
}

/**
 * The lock a model id resolves to, exact id first then under qualification
 * (`omen-alpha` matches a lock recorded for `opencode-go/omen-alpha`).
 */
export function modelLockFor(
  locks: Record<string, ModelTurnLock> | null | undefined,
  modelId: string | null | undefined,
): ModelTurnLock | undefined {
  if (!modelId) return undefined;
  const key = modelId.trim();
  if (!key) return undefined;
  const exact = locks?.[key];
  if (exact) return exact;
  const match = Object.entries(locks ?? {}).find(([locked]) => sameModelId(locked, key));
  return match?.[1];
}

/** Release the on-device lock for `modelId` (the operator cleared it). */
export function clearModelLock(
  locks: Record<string, ModelTurnLock> | undefined,
  modelId: string,
): Record<string, ModelTurnLock> {
  const a = modelLockFor(locks, modelId);
  if (!a) return locks ?? {};
  const next = { ...locks };
  delete next[a.model];
  return next;
}

/** The operator-facing line for a locked row: what it said and what to do. */
export function modelLockNote(lock: ModelTurnLock): string {
  const why = lock.reason?.trim() ? ` Reason: ${lock.reason.trim()}` : '';
  return `Locked on this device: ${lock.model}.${why} Pick another model or clear the lock.`;
}

/** The lock carried by every visible gate — counts nothing but actual tags. */
export function failedModelLocks(
  rows: readonly { id?: string; modelLocks?: unknown }[],
): { id?: string; modelLocks?: unknown }[] {
  return rows.filter((row) => row.modelLocks !== undefined && row.modelLocks !== null);
}

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
  /** The backend closed the turn without any assistant text (Gate `empty_turn`). */
  | 'empty_turn'
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
  // gate/core/server.mjs: a turn finished with neither text nor a tool. Hermes
  // does this when the pinned provider cannot authenticate (observed 2026-08-30:
  // Nous Portal, no access token) and still answers HTTP 200. The Gate wraps
  // the empty stream as this exact sentence so the phone does not show a
  // silent bubble.
  if (/no assistant content|empty_turn\b/i.test(text)) return 'empty_turn';
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
  empty_turn: {
    title: 'The model did not answer',
    next: 'The session is pinned to a model whose provider could not run (often a missing login — run hermes model on the host). Pick a model from a signed-in provider; a new session opens so the next turn actually runs on it.',
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
  if (sameModelId(requested, ran)) return null;
  const servedBy = report.provider?.trim() ? `${report.provider.trim()}/${ran}` : ran;
  if (sameModelId(requested, servedBy)) return null;
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
