// ─── Fleet constellation: the Bot star's tap ──────────────────────────────
// Tapping a Bot on the map should read its thread — but only when the tap
// can honestly make one: the Bot lives on the connected gateway and the
// Gate reports it routable. Anything else opens the roster's detail surface
// instead, which already carries the verdict and the fix (botRoutingView /
// describeBotDetail), so the press never pretends a chat exists.
//
// This is the Bot-side sibling of `gatewayHandshake` (`gateway-handshake.ts`):
// one pure decision supplies both the route's gate and the honest
// destination, so what the map allows and what the map says cannot disagree.
// The routability verdict is exactly `botReportedRoutable` from
// `roster-tap.ts` — one shared vocabulary of what cannot route, not a
// second one.

import type { BotRoutingIssue } from '@/lib/gateway/bots';
import type { RosterBotTapHandlers } from '@/lib/gateway/roster-tap';
import { botReportedRoutable } from '@/lib/gateway/roster-tap';

export type FleetBotTapInput = {
  /** The Bot's gateway is the one live connection right now. */
  connected: boolean;
};

export type FleetBotVerdict = {
  id: string;
  /** Gate-reported verdict; absent on older Gates — degrades to the boolean. */
  routable?: boolean;
  routingIssue?: BotRoutingIssue | null;
};

export type FleetBotTapHandlers = RosterBotTapHandlers;

/**
 * Which handler a tap on this Bot star invokes. On the connected gateway and
 * reported routable → open the chat; disconnected or the Gate says it cannot
 * route → open the roster detail surface carrying the fix; without a detail
 * handler, undefined exactly as a roster row without one never pretends.
 */
export function botTap(
  input: FleetBotTapInput,
  verdict: FleetBotVerdict,
  handlers: FleetBotTapHandlers,
): (() => void) | undefined {
  if (
    input.connected &&
    botReportedRoutable({ routable: verdict.routable ?? false, routingIssue: verdict.routingIssue })
  )
    return handlers.onChat;
  return handlers.onDetail;
}
