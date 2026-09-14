/**
 * The Bot cluster's tap decision, folded like everything else the fleet map
 * answers: the fold derives the tap consequence from facts the provider
 * already holds — the roster entry's `routable` verdict and the connection
 * status — so the renderer never re-derives routing from a truth it does not
 * hold.
 *
 * The vocabulary: a `routable: false` Bot is DRAWN but its tap resolves
 * nothing except its own detail words — never silently dead, and never a
 * Bot Chat open the provider would refuse.
 */

/**
 * What one Bot-node tap does on the map.
 *  - `open`: the Bot is routable and the gateway is connected — open Bot Chat
 *    through the provider's `openBot`, then navigate `/chat`.
 *  - `detail`: the Bot is drawn but not routable — the tap surfaces the Bot's
 *    own words (its routing verdict), it opens nothing.
 *  - `none`: somebody tapped a node whose Bot the roster dropped between the
 *    fold and the tap — a stale seat answers nothing at all.
 */
export type FleetBotTapAction =
  | { kind: 'open'; botId: string }
  | { kind: 'detail'; botId: string; issue: string }
  | { kind: 'none' };

/**
 * Fold one tap to its consequence. `routable` and `issue` are the roster
 * entry's own fields handed through un-reworded (`PublicBot.routable`, the
 * `routingIssue` verdict newer Gates report); `connected` answers whether the
 * gateway behind the cluster is the connected one — on a saved cluster the
 * fold opens nothing, because this client holds no live session to scope.
 */
export function fleetBotTapAction({
  bot,
  connected,
}: {
  bot: { botId: string; routable: boolean; issue?: string } | undefined;
  connected: boolean;
}): FleetBotTapAction {
  if (!bot) return { kind: 'none' };
  if (!connected) return { kind: 'detail', botId: bot.botId, issue: bot.issue ?? 'Not routable' };
  if (!bot.routable) {
    return { kind: 'detail', botId: bot.botId, issue: bot.issue ?? 'No listen key' };
  }
  return { kind: 'open', botId: bot.botId };
}
