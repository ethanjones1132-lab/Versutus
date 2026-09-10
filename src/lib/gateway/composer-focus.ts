// ─── A requested composer focus ───────────────────────────────────
// Item 8's Bot Chat link (`versutus://chat?bot=<id>`) opens a thread AND asks
// for the cursor in the composer it opens — "Bot Chat, composer focused"
// (FUTURE-ITEMS.md:263-264). The open is a gateway read, so the request is
// folded here and held on the provider until the Chat screen is showing that
// Bot Chat: the same shape as a requested chat surface
// (`@/lib/gateway/surface-request`), except that a focus is a one-shot — the
// screen clears it as it applies it, so one ask cannot take the cursor twice.
//
// Pure, so both rules are jest-pinnable and need no renderer.

import type { ChatSurface } from '@/lib/gateway/bots';

/**
 * The Bot Chat whose composer the operator asked for. The id is what makes two
 * requests the same request; the consumer also uses it to check the request is
 * for the thread on screen, and for nothing else.
 */
export type ComposerFocus = { botId: string };

/**
 * Fold a request into the pending slot. A request for the Bot Chat already
 * pending returns that value unchanged — the screen's effect keys on it, and a
 * fresh object would re-apply a focus that is already pending.
 */
export function pendingComposerFocus(
  pending: ComposerFocus | null,
  requested: ComposerFocus,
): ComposerFocus | null {
  if (pending && pending.botId === requested.botId) return pending;
  return requested;
}

/**
 * Whether a pending request is the surface in front of the operator. A request
 * naming another thread is not applied — the composer it names is not the one
 * on screen — and the screen holds it rather than dropping it: the promise was
 * that Bot Chat, and the operator may still arrive at it.
 */
export function composerFocusApplies(focus: ComposerFocus | null, surface: ChatSurface): boolean {
  return focus !== null && surface.kind === 'bot' && surface.botId === focus.botId;
}
