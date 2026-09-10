// ─── A requested chat surface ─────────────────────────────────────
// The chat screen owns which surface it shows, but a request to move it can
// arrive from outside the screen: the quick-reply path opens a Bot Chat in the
// provider (the transcript the chat context shares changes) and the screen has
// to follow, or its header names one thread over another thread's turns.
// The request is folded here so a later one wins and a repeat of the pending
// one changes nothing.

import type { ChatSurface } from '@/lib/gateway/bots';

/**
 * Identifies a surface by what it shows. Two surfaces with the same key name
 * the same thread, which is what lets a repeated request be a no-op. The ids
 * carry their kind: a Bot id and a group id are unrelated identifiers.
 */
export function surfaceKey(surface: ChatSurface): string {
  switch (surface.kind) {
    case 'bot':
      return `bot:${surface.botId}`;
    case 'group':
      return `group:${surface.groupId}`;
    default:
      return surface.kind;
  }
}

/**
 * Fold a request into the pending slot. A request for the surface already
 * pending returns that value unchanged — the consumer's effect keys on it, and
 * a fresh object would re-apply a surface that is already on screen. Anything
 * else replaces what was pending: the request that arrived last is the one the
 * provider's own state (the transcript, the pinned session) is now describing.
 */
export function pendingSurface(
  pending: ChatSurface | null,
  requested: ChatSurface,
): ChatSurface | null {
  if (pending && surfaceKey(pending) === surfaceKey(requested)) return pending;
  return requested;
}
