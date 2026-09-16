// ─── Fleet constellation: the Bot star's detail sheet ─────────────────────
// A Bot star's label is packed to ~50px on a phone (BOT_LABEL_WIDTH in
// constellation-model.ts), so names ellipsize and a tap leaves the map —
// there was no way to READ a star without opening its Chat. A long-press
// opens this sheet instead: the same facts the map's badges and the roster
// row already hold, folded into one pure view-model the route renders.
//
// Pure and honest: every field is either what the model's node already
// emitted or a field of the roster's PublicBot — no new reads, nothing
// invented for a fact the map did not show, and never a credential.

export type BotSheetNodeInput = {
  label: string;
  botId?: string;
  runningRunName?: string;
  badges: readonly { label: string; tone: string }[];
};

export type BotSheetBotInput = {
  displayName?: string;
  description?: string | null;
};

export type BotSheetView = {
  /** The full name — the roster's own, or the map label when no row exists. */
  name: string;
  /** The Hermes profile id, or null when the node carried none. */
  id: string | null;
  description: string | null;
  /** The one live run's name this device saw, or null. */
  running: string | null;
  /** The worst routine verdict's own badge word, or null when none was shown. */
  routine: string | null;
  /** The pending approval badge, or null. */
  approvals: string | null;
};

/**
 * Fold a Bot constellation node plus its roster row (when the map has one)
 * into what the sheet shows. Every field is something the map already said
 * — the badges travel verbatim so the sheet and the map cannot name one
 * state two ways.
 */
export function botSheetView(input: {
  node: BotSheetNodeInput;
  bot?: BotSheetBotInput | null;
}): BotSheetView {
  const { node, bot } = input;
  const approvalBadge = node.badges.find((badge) => badge.label.includes('approval'));
  const routineBadge = node.badges.find((badge) => badge.label.startsWith('routine'));
  const runName = node.runningRunName?.trim();
  return {
    // The full name the clipped label cannot hold is exactly why this sheet
    // exists: prefer the roster's name, never truncate here.
    name: bot?.displayName?.trim() || node.label,
    id: node.botId ?? null,
    description: bot?.description ?? null,
    running: runName ? runName : null,
    routine: routineBadge?.label ?? null,
    approvals: approvalBadge?.label ?? null,
  };
}
