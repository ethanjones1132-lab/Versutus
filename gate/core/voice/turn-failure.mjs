// ─── What a failed turn is called on the phone ───────────────────────────
// A backend's own error text is written for its own log: it can quote the
// prompt it failed on, and at best it reads as "claude-code exited with code 1"
// on a call banner. The phone is told which kind of failure it was, in one
// sentence the Gate wrote, and the host log keeps the code. The backend's words
// never cross the wire (S3).

const BACKEND_LABELS = Object.freeze({
  'claude-code': 'Claude Code',
  codex: 'Codex',
  hermes: 'Hermes',
  opencode: 'OpenCode',
});

/** A backend's display name, or a neutral one when the Gate cannot name it. */
export function backendLabel(kind) {
  if (typeof kind !== 'string' || !kind) return 'The backend';
  return BACKEND_LABELS[kind] ?? 'The backend';
}

/**
 * @param {unknown} error what the turn threw, or `{ code }` for a named ending
 * @param {{ backend?: string }} [context] the backend kind that ran the turn
 * @returns {{ code: string, message: string }} a stable code for the log and a
 *   sentence that is safe to show and to keep
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
