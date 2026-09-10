// ─── A requested composer text ────────────────────────────────────
// Item 5's share half: a `versutus://compose?text=&bot=` link (and, later, an
// Android SEND intent) carries text that belongs in a thread's composer — never
// in the send path (FUTURE-ITEMS.md:193-194, "it goes into the composer as a
// draft, never auto-sent"). The link is answered in the router, where the
// composer's draft does not exist, and that draft belongs to the Chat screen:
// the request is folded here and held on the provider until the screen is
// showing the thread it names — the same shape as a requested composer focus
// (`@/lib/gateway/composer-focus`), except that this one carries words.
//
// Pure, so both rules are jest-pinnable and need no renderer.

import type { ChatSurface } from '@/lib/gateway/bots';

/**
 * Text a shared link wants put in a thread's composer, and the thread when the
 * link names one. A request carries a text and a Bot id and nothing else —
 * there is no field here a send could ride in on.
 */
export type ComposeRequest = { text: string; botId?: string };

/**
 * Fold a request into the pending slot. The same text for the same thread is
 * the same request and returns the pending value unchanged — the screen's
 * effect keys on it, and a fresh object would re-write a draft that is already
 * there. Anything else replaces what was pending: the request that arrived last
 * is the text the operator last shared.
 */
export function pendingComposeRequest(
  pending: ComposeRequest | null,
  requested: ComposeRequest,
): ComposeRequest | null {
  if (pending && pending.text === requested.text && pending.botId === requested.botId) {
    return pending;
  }
  return requested;
}

/**
 * Whether a pending request is for the surface in front of the operator. A
 * request that names a Bot is for that Bot's own Bot Chat and no other thread;
 * a request naming no Bot is for whichever thread the operator already has up —
 * a shared text arrives with no opinion about where it goes, so it lands where
 * the operator is looking rather than pulling them somewhere else.
 *
 * The roster and a group room are not that thread: the roster has no composer
 * of this screen's, and a group room keeps its own draft to itself, so a shared
 * text handed to either could not be written. The screen holds the request
 * instead (the rule `composerFocusApplies` already follows for another thread).
 */
export function composeRequestApplies(request: ComposeRequest | null, surface: ChatSurface): boolean {
  if (!request) return false;
  if (request.botId !== undefined) {
    return surface.kind === 'bot' && surface.botId === request.botId;
  }
  return surface.kind === 'bot' || surface.kind === 'configurable';
}
