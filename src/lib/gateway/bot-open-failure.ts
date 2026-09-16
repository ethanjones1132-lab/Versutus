// ─── Does a failed Bot Chat open still belong to its Bot? ─────────────────
// `openBot` scopes the client to a Bot, then lists that Bot's sessions to find
// its chat. When the listing failed it cleared the scope — but the Bot Chat
// stayed on screen, so the operator's next message went out with no Bot at all.
// On a Gate that means the provider fallback: an arbitrary provider model, and
// on 2026-09-16 "chat failed: 404" for a Bot whose host was merely slow while
// Hermes recovered from a startup migration.
//
// So the question is whether the failure says the Bot is GONE or only that the
// host was slow to answer. A slow host keeps the Bot: a send carries `bot=` and
// the Gate opens a fresh session for it. A Bot that is unknown, unroutable or
// refused drops the scope, as before. Anything unexplained is not assumed
// transient — keeping a scope that should have been dropped is the costlier
// mistake to make silently.

import { GatewayHttpError } from '@/lib/gateway/errors';

/** Statuses that mean the host did not answer in time, not that it said no. */
const TRANSIENT_STATUSES = new Set([408, 429, 502, 503, 504]);

/**
 * The Gate reports a Hermes read that outran its bound as a 500 whose message
 * says so (`readCall`, gate/core/cli-environments/backends/hermes.mjs).
 */
const TIMEOUT_MESSAGE = /did not answer|not answering|timed out/i;

export function botOpenFailureKeepsScope(error: unknown): boolean {
  if (error instanceof GatewayHttpError) {
    if (TRANSIENT_STATUSES.has(error.status)) return true;
    return error.status === 500 && TIMEOUT_MESSAGE.test(error.message);
  }
  if (!(error instanceof Error)) return false;
  // Transport-level failures never reached a status line at all.
  if (/^Request timed out:/.test(error.message)) return true;
  return error instanceof TypeError && /network request failed/i.test(error.message);
}
