// ─── Bot scorecards ───────────────────────────────────────────────
// D3's per-Bot track record (FUTURE-ITEMS.md §D3 Build 1): fold the run rows
// this device persisted into one card per Bot. Pure — the Activity surface
// reads the provider's runs and calls this; nothing here touches storage, a
// gateway, or a renderer.
//
// Honesty rules this fold enforces, each one a way a count could lie:
// - A cancelled run is not a failure. The operator stopped it, so it gets its
//   own count rather than inflating a failure rate it never earned.
// - A run that never reached a terminal state counts where it is, in flight,
//   never as one of the settled fates.
// - A row naming no Bot is not dropped and never guessed into a card: all of
//   them share the one unattributed bucket (D3:792-797).
//
// These cards are observations of runs this device saw — a run started from
// the desktop or the TUI never reaches this list at all. The surface owes that
// sentence once, in its footer; nothing here may word a count as a
// gateway-side total.

import type { ActivityRun } from '@/lib/gateway/runs';

/** What became of the runs one card counted. */
export type ScorecardFates = {
  complete: number;
  failed: number;
  cancelled: number;
  unresolved: number;
  /** Not settled yet — running, or waiting on the operator's approval. */
  inFlight: number;
};

export type BotScorecard = {
  /**
   * The Bot the card is about; `null` is the unattributed bucket — configurable
   * chat, and every row persisted before the field existed.
   */
  botId: string | null;
  /** Every row counted here — the fates always sum to it. */
  total: number;
  fates: ScorecardFates;
};

/**
 * The one bucket a run's status puts it in. `unresolved` is settled (the run is
 * over, its fate unknown) and stays its own count, apart from `failed`; only
 * `running` and `waiting-approval` are still live.
 */
export function scorecardFate(status: ActivityRun['status']): keyof ScorecardFates {
  if (status === 'complete') return 'complete';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'unresolved') return 'unresolved';
  return 'inFlight';
}

/** An id is an id only when it is present and not empty — anything else is not one. */
function scorecardBotId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function emptyFates(): ScorecardFates {
  return { complete: 0, failed: 0, cancelled: 0, unresolved: 0, inFlight: 0 };
}

/**
 * One card per Bot, in the order the rows arrive — the persisted list is
 * newest-first, so the Bot the operator last ran comes first. A Bot this device
 * has seen no runs for gets no card: an empty card would read as a Bot that
 * fails at nothing.
 */
export function buildScorecards(runs: readonly ActivityRun[]): BotScorecard[] {
  const cards = new Map<string | null, BotScorecard>();

  for (const run of runs) {
    const botId = scorecardBotId(run.botId);
    let card = cards.get(botId);
    if (!card) {
      card = { botId, total: 0, fates: emptyFates() };
      cards.set(botId, card);
    }
    card.total += 1;
    card.fates[scorecardFate(run.status)] += 1;
  }

  return [...cards.values()];
}
