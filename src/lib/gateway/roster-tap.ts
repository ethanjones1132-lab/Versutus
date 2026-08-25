// ─── Roster row tap: what pressing a Bot's row does ────────────────────────
//
// The roster row is one line by design, so the routing verdict lives in the
// subtitle ("No listen key" / "Default listen key refused") and the FIX lives
// in the detail surface. That split left the unroutable row's press as a
// silent no-op: an operator reading "Default listen key refused" tapped the
// row anyway — the natural gesture — and nothing happened. This module makes
// the decision explicit and pure: a routable row opens its chat; an
// unroutable row opens the detail surface that names the fix; when no detail
// surface exists (older callers), the press stays undefined rather than
// pretending.
//
// Routability here follows the SAME precedence as botRowSubtitle,
// botChipRoutingTag, and describeBotDetail: a Gate-reported routingIssue wins
// over a stale `routable: true`, because every reported issue means the bot
// cannot route — that is what the report is for. The check stays generic over
// the issue VALUE on purpose (any issue ⇒ unroutable) so a newer Gate adding
// a verdict degrades correctly instead of falling back to the stale boolean.

import type { PublicBot } from './bots';

/** Handlers a roster row can be wired to; `onDetail` is optional because the prop is. */
export type RosterBotTapHandlers = {
  onChat: () => void;
  onDetail?: () => void;
};

/**
 * Can this Bot route, by everything the Gate reported? True only when the
 * Gate says routable AND reports no routing issue — the same verdict the
 * detail sheet renders, stronger than the bare boolean the row used to trust.
 */
export function botReportedRoutable(bot: Pick<PublicBot, 'routable' | 'routingIssue'>): boolean {
  if (bot.routingIssue) return false;
  return Boolean(bot.routable);
}

/**
 * Which handler a tap on this Bot's roster row invokes. Routable → chat;
 * anything the Gate cannot route → the detail surface carrying the fix
 * (never silence while that surface exists); without a detail handler the
 * press is undefined exactly as before.
 */
export function rosterBotTap(
  bot: Pick<PublicBot, 'routable' | 'routingIssue'>,
  handlers: RosterBotTapHandlers,
): (() => void) | undefined {
  if (botReportedRoutable(bot)) return handlers.onChat;
  return handlers.onDetail;
}
