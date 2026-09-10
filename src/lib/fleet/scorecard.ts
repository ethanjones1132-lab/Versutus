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
//
// The window line names the cap the persistence layer enforces, imported from
// it rather than retyped, so the bound in the copy cannot drift from the bound
// on the list it describes.

import { ACTIVITY_RUNS_PERSIST_CAP } from '@/lib/gateway/session-persistence';
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

/**
 * What the Activity tab's run list is filtered to. `null` is no filter at all —
 * the unfiltered list the tab showed before scorecards existed — so tapping the
 * unattributed card (`{ botId: null }`) stays a state of its own rather than
 * quietly meaning "show everything".
 */
export type ScorecardFilter = { botId: string | null } | null;

/**
 * The runs one card counted, in the order they were read. A row that names no
 * Bot — or names a Bot other than the selected one — belongs to another card
 * and is left out rather than shown under the wrong heading. No filter is the
 * list the tab already showed, returned as it arrived: the tab must be
 * byte-identical to what it rendered before scorecards existed.
 */
export function filterRunsByBot(
  runs: readonly ActivityRun[],
  filter: ScorecardFilter,
): readonly ActivityRun[] {
  if (!filter) return runs;
  const wanted = scorecardBotId(filter.botId);
  return runs.filter((run) => scorecardBotId(run.botId) === wanted);
}

/**
 * What a card is titled. A Bot's own id is its name; the rows that name no Bot
 * share one heading, worded the spec's way ("unattributed", D3:792-797) rather
 * than as an id, so the bucket is never read as a Bot of that name.
 */
export function scorecardBotLabel(botId: string | null): string {
  return scorecardBotId(botId) ?? 'Unattributed';
}

/** The fates in the fold's own order, with the word each one reads as. */
const FATE_COPY: readonly (readonly [keyof ScorecardFates, string])[] = [
  ['complete', 'complete'],
  ['failed', 'failed'],
  ['cancelled', 'cancelled'],
  ['unresolved', 'unresolved'],
  ['inFlight', 'in flight'],
];

/**
 * A card's one counts line, e.g. `3 complete · 1 failed · 2 in flight`. Only
 * the fates this card actually holds are printed: a zero would be noise, and
 * a settled count is never dressed as another (a cancelled run is not a
 * failure, an unresolved run is not one either). A card with nothing to count
 * prints nothing rather than `0`.
 */
export function scorecardFateCopy(fates: ScorecardFates): string {
  return FATE_COPY.filter(([fate]) => fates[fate] > 0)
    .map(([fate, word]) => `${fates[fate]} ${word}`)
    .join(' · ');
}

/**
 * Honest window line for the cards (D3's Build 2, `FUTURE-ITEMS.md:808-810`).
 *
 * The run list this device persists is capped (`ACTIVITY_RUNS_PERSIST_CAP`), so
 * a fold can never see more than the newest cap rows: a filled read has older
 * runs missing off the end, and naming that bound is the difference between
 * "these Bots ran this often" and "this is all any Bot ever did". Same
 * discipline as `spendSessionCapCopy` over the 200-session catalogue read.
 *
 * Callers pass the ROW count the fold was handed, not the cards it produced, so
 * a read that hit the cap says so even when some of its rows folded into the
 * unattributed bucket. A partial read is everything this device holds, and
 * claims no bound it did not hit; an unreadable count prints `0` rather than
 * `NaN`.
 */
export function scorecardWindowCopy(runCount: number): string {
  const rows = Number.isFinite(runCount) ? Math.max(0, Math.floor(runCount)) : 0;
  if (rows >= ACTIVITY_RUNS_PERSIST_CAP) {
    return `Newest ${ACTIVITY_RUNS_PERSIST_CAP} runs — older runs are past the list's cap`;
  }
  return `${rows} run${rows === 1 ? '' : 's'} in this read`;
}

/**
 * The one sentence the Scorecards section owes its reader (D3's Constraints,
 * `FUTURE-ITEMS.md:824-828`): these cards count the runs this app started, and
 * a run launched from the desktop or the TUI never reaches this list at all.
 * The section renders it once, under the cards — never on a card, and never
 * worded as a gateway-side total.
 */
export const SCORECARD_FOOTER_COPY = 'Runs seen from this device — a run started from the desktop or the TUI never reaches this list.';
