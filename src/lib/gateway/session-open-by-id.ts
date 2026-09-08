// ─── Open a session by exact id ─────────────────────────────────────────────
//
// The thread sheet lists a window of `sessions.list`, so a session outside the
// window (or named on another device, e.g. from the spend glance or
// `/session usage <id>`) is reachable today only by typing `/session get <id>`
// or paging older. The Gate already dispatches `session.get` as an exact-id
// read (`gate/core/capabilities/gateway-methods.mjs:259-260`, via
// `findSessionById` at :80-88), the registry names it `/session get`
// (`src/lib/gateway/dashboard.ts:630-639`), and the slash handler answers it
// (`src/lib/gateway/slash-commands.ts:1144-1145`) — but no component calls it.
//
// So the sheet's "Open by id" row reads `session.get` ahead of the existing
// switch: a resolved read means the gateway still holds the session and the
// existing `onSelect` (itself validated through `session.restore`) may run; a
// rejection names the failure and the current thread stays put. Never switch
// on a missing id.

import type { ThreadSwitchRequest, ThreadSwitchValidation } from './thread-switch';

/** Trim pasted ids (trailing newline/space from a copied spend-glance id). */
export function normalizeSessionIdInput(raw: string): string {
  return raw.trim();
}

/**
 * Read `session.get` ahead of the existing switch. Empty input fails without
 * firing a request; a resolved read means the switch may proceed; a rejection
 * carries the failure so the caller can name it and keep the current thread.
 * No request function means the method is not dispatched on this path — the
 * switch proceeds instantly, exactly today's behaviour.
 */
export async function openSessionById(
  request: ThreadSwitchRequest | undefined,
  sessionId: string,
): Promise<ThreadSwitchValidation> {
  const id = normalizeSessionIdInput(sessionId);
  if (!id) return { ok: false, error: 'Enter a session id' };
  if (!request) return { ok: true };
  try {
    await request('session.get', { sessionId: id });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The failure copy for a rejected open-by-id read. Names the id the operator
 * typed so a pasted id that the gateway no longer holds reads as its own
 * miss, not a broken button.
 */
export function openSessionByIdFailureText(sessionId: string, error: string): string {
  return `Session ${sessionId} could not be opened: ${error}`;
}
