// ─── A connection failure may not outlive the connection ──────────────────
// `lastError` is written from two places with different lifetimes: the connect
// attempt itself, and the client's `onError` channel, which reports at ANY
// time — including while the socket is up and the Gate is merely restarting.
// `decideConnectionPhase` clears it on the TRANSITION into connected
// (`phase.ts:56`), so an error recorded while already connected has nothing
// left to clear it.
//
// The card it feeds is not a neutral message. It reads "The API key or token
// was refused. Affected: gateway connection. Next: Open gateway setup and
// update the token." (`error-humanizer.ts:31-37`). Shown beside a CONNECTED
// badge — as it was on 2026-09-16 — it states something the live connection
// disproves, and sends the operator to replace a token that works.
//
// So the rule is about what the app can honestly claim, not about tidiness: a
// gateway that is answering has refused nothing. A failure still shows in every
// state where the connection is NOT proving otherwise, which is where the
// operator can actually act on it.

import type { ConnectionStatus } from '@/lib/gateway/types';

/**
 * The connection failure worth showing, or `null`.
 *
 * `connected` is the one state that disproves a connection-level failure; every
 * other state (including `pairing` and `reconnecting`, where the reason is the
 * whole point) keeps it.
 */
export function connectionErrorShown(
  status: ConnectionStatus,
  lastError: string | null | undefined,
): string | null {
  const error = lastError?.trim();
  if (!error) return null;
  if (status === 'connected') return null;
  return error;
}
