// ─── What a failed turn is called on the phone ───────────────────────────
// A backend's own error text is written for its own log: it can quote the
// prompt it failed on, and at best it reads as "claude-code exited with code 1"
// on a call banner. The phone is told which kind of failure it was, in one
// sentence the Gate wrote, and the host log keeps the code. On a call the
// backend's words never cross the wire at all (S3); a typed turn keeps them
// beside the sentence as `details`, where the app can offer them and never
// leads with them.
//
// Two failures are different: a backend that is signed out, and one whose plan
// is spent. Those are the ones the operator can fix from the sentence alone, so
// each backend gets a sentence naming the one command that fixes it (VS-127).
// The backend's own text still rides along as `details` for whoever wants it,
// but it is never the headline.

const BACKEND_LABELS = Object.freeze({
  'claude-code': 'Claude Code',
  codex: 'Codex',
  hermes: 'Hermes',
  opencode: 'OpenCode',
});

/**
 * How each backend says "sign in again", in the place its credentials live.
 *
 * `where` names the thing that is signed out (these CLIs run on the operator's
 * PC, and a sentence that does not say so reads as though the phone were), and
 * `fix` is the one action that repairs it. Hermes has no sign-in command: its
 * credentials are configured in its own settings.
 */
const SIGN_IN = Object.freeze({
  'claude-code': {
    where: 'Claude Code on your PC',
    fix: 'Open a terminal on the PC, run `claude`, and sign in.',
  },
  codex: {
    where: 'Codex on your PC',
    fix: 'Open a terminal on the PC, run `codex login`, and sign in.',
  },
  opencode: {
    where: 'OpenCode on your PC',
    fix: 'Open a terminal on the PC, run `opencode auth login`, and sign in.',
  },
  hermes: {
    where: 'Hermes',
    fix: 'Open Hermes on the PC and sign in again.',
  },
});

const GENERIC_SIGNED_OUT = 'The backend is signed out. Sign in again on the machine that runs it.';

/**
 * How a CLI says "I am not signed in". The words are the CLI's own: a process
 * that exits before it can answer reports nothing else, and the Gate has to
 * read them because there is no typed status on a stderr line.
 */
const SIGNED_OUT_TEXT = [
  /\boauth\b/i,
  /\btoken (?:has been|was) revoked\b/i,
  /\bnot logged in\b/i,
  /\bnot signed in\b/i,
  /\bplease run \/login\b/i,
  /\bplease run\b[^.\n]{0,40}\blogin\b/i,
  /\bauthentication\b/i,
  // Claude Code reports its own sign-in failure as `result: "Failed to
  // authenticate. …"` (backends/claude-code.mjs recognises exactly that
  // prefix), which `authentication` does not match: the CLI uses the verb.
  /\bfailed to authenticate\b/i,
  /\bunauthorized\b/i,
  /\binvalid api key\b/i,
  // OpenCode says it this way when `opencode auth login` was never run for a
  // provider: there is no credential to send, not a refused one. The Gate's own
  // `provider has no credential to send` is deliberately NOT this: that is a
  // provider record on the PC to configure, not a CLI to sign in (the app's
  // `missing_credentials` verdict owns it).
  /\bno (?:provider )?credentials?\b(?! to send)/i,
];

/**
 * A bare status number in the words, which is a weaker sign than a word.
 *
 * It is only the CLI's own sign-in state when the throw carries no status of
 * its own: when it does, the 401/403 is the credential the Gate holds for the
 * backend (Hermes's API_SERVER_KEY, an OpenCode server password), and
 * `backend_auth` — not a sign-in command — is the honest verdict.
 */
const SIGNED_OUT_STATUS_TEXT = [/\b401\b/, /\b403\b/];

/**
 * How a CLI says "the plan is spent". `quota` and `billing` cover the vendor
 * spellings (`insufficient_quota`, `credit balance`, …); a bare rate limit is
 * only a quota when the CLI also says when it resets, because otherwise it is
 * the transient `backend_rate_limited` the call already knows.
 */
const QUOTA_TEXT = [
  /\busage limit\b/i,
  /\bquota\b/i,
  /insufficient_quota/i,
  /\bcredit balance\b/i,
  /\binsufficient (?:balance|credit|funds)\b/i,
  /\bout of credits?\b/i,
  /\bbilling\b/i,
  /\bexceeded your (?:current )?(?:quota|plan)\b/i,
  /\bspend(?:ing)? limit\b/i,
];

const RATE_LIMIT_TEXT = /\brate[- ]?limit(?:ed|ing)?\b/i;
const RESET_TEXT = /\b(?:resets?|retry after|try again|available again|renews?)\b/i;

/** The backend kind a label or an environment id names, when it names one. */
function backendKind(kind) {
  if (typeof kind !== 'string' || !kind) return '';
  const lower = kind.toLowerCase();
  if (SIGN_IN[lower]) return lower;
  // A typed turn knows its environment id (`claude-code-local`), not the kind
  // the voice runner holds; the id carries the kind's own name.
  for (const known of Object.keys(SIGN_IN)) {
    if (lower.includes(known)) return known;
  }
  return '';
}

/** A backend's display name, or a neutral one when the Gate cannot name it. */
export function backendLabel(kind) {
  const known = backendKind(kind);
  if (known) return BACKEND_LABELS[known];
  return 'The backend';
}

/**
 * The sentence for a backend that is signed out, naming the one fix.
 *
 * The backend's own text is deliberately absent: it quotes the prompt it failed
 * on and names tokens nobody on the phone can act on.
 */
export function signedOutMessage(kind) {
  const known = backendKind(kind);
  if (!known) return GENERIC_SIGNED_OUT;
  const { where, fix } = SIGN_IN[known];
  return `${where} is signed out. ${fix}`;
}

/**
 * The sentence for a backend whose plan is spent, with the reset moment the
 * CLI named when it named one.
 */
export function quotaMessage(kind, text = '') {
  const who = backendLabel(kind);
  const when = resetMoment(text);
  return when
    ? `${who} has used up its plan's limit. It resets ${when}; until then pick another backend.`
    : `${who} has used up its plan's limit. Until it resets, pick another backend.`;
}

/** The moment the CLI said it resets, as a fragment ("at 14:00"), or ''. */
function resetMoment(text) {
  if (typeof text !== 'string' || !text) return '';
  const match = /\bresets?\s+(?:(at|on|in)\s+)?([^.;\n]{1,40})/i.exec(text)
    ?? /\b(?:retry after|available again|renews?)\s+(?:(at|in)\s+)?([^.;\n]{1,40})/i.exec(text)
    // Codex's own wording on a spent plan: "… or try again at 1:37 PM." The
    // connector is required here so a bare "try again later" names no moment.
    ?? /\btry again\s+(at|in)\s+([^.;\n]{1,40})/i.exec(text);
  if (!match) return '';
  const when = match[2].replace(/[\s,]+$/, '').trim();
  if (!when) return '';
  return `${match[1] ?? 'at'} ${when}`;
}

function looksSignedOut(text, status = 0) {
  if (SIGNED_OUT_TEXT.some((pattern) => pattern.test(text))) return true;
  // A number is only evidence when nothing already said where the refusal came
  // from: `hermes: HTTP 401` with `status: 401` is the Gate's own key refused.
  return !status && SIGNED_OUT_STATUS_TEXT.some((pattern) => pattern.test(text));
}

function looksOverQuota(text) {
  if (QUOTA_TEXT.some((pattern) => pattern.test(text))) return true;
  // "rate limit" alone is transient; with a reset it is the plan's ceiling.
  return RATE_LIMIT_TEXT.test(text) && RESET_TEXT.test(text);
}

/**
 * @param {unknown} error what the turn threw, or `{ code }` for a named ending
 * @param {{ backend?: string }} [context] the backend kind (or environment id)
 *   that ran the turn
 * @returns {{ code: string, message: string, details?: string }} a stable code
 *   for the log, a sentence that is safe to show and to keep, and — for the two
 *   actionable failures — the backend's own text behind it
 */
export function describeTurnFailure(error, { backend } = {}) {
  const who = backendLabel(backend);
  const code = typeof error?.code === 'string' ? error.code : '';
  const status = Number.isFinite(error?.status) ? error.status : 0;
  const text = typeof error?.message === 'string' ? error.message : '';

  // The Gate's own refusal already says which environments it tried and why.
  if (code === 'no_voice_backend') {
    return { code, message: text || 'No chat backend could answer this call.' };
  }
  if (code === 'turn_timeout') {
    return { code, message: `${who} took too long to answer.` };
  }
  if (code === 'empty_turn') {
    return { code, message: `${who} finished without saying anything.` };
  }
  if (code === 'backend_stall') {
    return { code, message: `${who} accepted the turn and then went quiet.` };
  }
  if (code === 'stream_truncated') {
    return { code, message: 'The reply was cut off before it finished.' };
  }
  // A caller that already named one of the actionable endings still gets the
  // same sentence; the code is the authority there, not the wording.
  if (code === 'backend_signed_out') {
    return { code, message: signedOutMessage(backend), ...(text ? { details: text } : {}) };
  }
  if (code === 'backend_quota') {
    return { code, message: quotaMessage(backend, text), ...(text ? { details: text } : {}) };
  }

  // VS-127: the two failures the operator can fix from the sentence. The words
  // are read before the status, because a CLI reports its own sign-in state as
  // stderr and often nothing else.
  if (looksSignedOut(text, status)) {
    return { code: 'backend_signed_out', message: signedOutMessage(backend), ...(text ? { details: text } : {}) };
  }
  if (looksOverQuota(text)) {
    return { code: 'backend_quota', message: quotaMessage(backend, text), ...(text ? { details: text } : {}) };
  }
  if (status === 401 || status === 403) {
    return { code: 'backend_auth', message: `${who} refused the sign-in the Gate has for it.` };
  }
  if (status === 404) {
    return { code: 'backend_not_found', message: `${who} no longer has this conversation.` };
  }
  if (status === 429) {
    return { code: 'backend_rate_limited', message: `${who} is rate limited right now.` };
  }
  if (status >= 500) {
    return { code: 'backend_unavailable', message: `${who} is not answering right now.` };
  }
  if (/exited with code|ENOENT|spawn /i.test(text)) {
    return { code: 'backend_exited', message: `${who} stopped before it answered.` };
  }
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i.test(text)) {
    return { code: 'backend_unreachable', message: `${who} could not be reached.` };
  }
  return { code: code || 'backend_error', message: `${who} failed before it answered.` };
}
