/**
 * D7 council planner (FUTURE-ITEMS.md §D7, "Council mode — broadcast and
 * compare") — the model half, before any comparison view exists.
 *
 * The item is pure: `planCouncil` decides WHICH Bot sends happen, in roster
 * order, and `foldCouncilResults` keys what came back by Bot — with the same
 * roster order so a comparison view can render answers side by side without
 * re-deriving who is who. The fold adds no send and grows no plan.
 */

export type CouncilRequest = { botId: string; text: string };

/** A Bot any caller's roster fits — the roster's own rows carry these. */
export type CouncilBot = { id: string; displayName: string };

/** What one Bot's fan-out leg produced: a reply, or the reason it was silent. */
export type CouncilReply =
  | { botId: string; text: string; ok: true }
  | { botId: string; text?: string; ok: false; error?: string };

/** One Bot's comparison slot, keyed by the roster the plan was built from. */
export type CouncilResultSlot = {
  bot: CouncilBot;
  reply?: { text: string };
  error?: string;
};

/**
 * One prompt to several Bots, in roster order — the D7 broadcast shape.
 * Deduplicated by Bot id so a caller's overlap cannot ask one Bot twice,
 * and a Botless roster plans nothing rather than inventing a send.
 *
 * The council is NOT a group room: no @mention scoping, no multi-round plan —
 * group rooms (groups.ts, planGroupRounds) stay byte-identical, and the
 * per-Bot send path rides the same session-create + send the Gate's
 * deliverGroupMessage already proves works (hermes.mjs).
 */
export function planCouncil(bots: readonly CouncilBot[], prompt: string): CouncilRequest[] {
  const seen = new Set<string>();
  const steps: CouncilRequest[] = [];
  for (const bot of bots) {
    if (seen.has(bot.id)) continue;
    seen.add(bot.id);
    steps.push({ botId: bot.id, text: prompt });
  }
  return steps;
}

/**
 * Key replies and errors by Bot, keeping the roster's order — the reply
 * arrivals never reorder the comparison. Rows for a Bot the roster never
 * had are dropped rather than invented, and a silent Bot gets an empty slot
 * so the view can show who answered, and who did not.
 */
export function foldCouncilResults(input: {
  roster: readonly CouncilBot[];
  replies: readonly CouncilReply[];
  errors?: readonly CouncilReply[];
}): CouncilResultSlot[] {
  const roster = input.roster.slice();
  const byBot = new Map<string, { reply?: { text: string }; error?: string }>();
  for (const row of input.replies) {
    if (!byBot.has(row.botId)) byBot.set(row.botId, {});
    const slot = byBot.get(row.botId)!;
    if (row.ok) {
      const text = typeof row.text === 'string' ? row.text : '';
      if (text.length > 0) slot.reply = { text };
    } else {
      slot.error = row.error ?? 'no reply';
    }
  }
  if (input.errors) {
    for (const row of input.errors) {
      if (typeof row.ok === 'boolean' && row.ok) continue;
      if (!byBot.has(row.botId)) byBot.set(row.botId, {});
      const slot = byBot.get(row.botId)!;
      if (!slot.error) slot.error = row.error ?? 'no reply';
    }
  }
  return roster.map((bot) => {
    const slot = byBot.get(bot.id);
    return slot ? { bot, ...slot } : { bot };
  });
}
