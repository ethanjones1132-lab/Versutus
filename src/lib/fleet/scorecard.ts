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
// - An approval count is read off the row that recorded it and never inferred:
//   a decision the operator made is the `approved` written on the row, a
//   request still blocked on them is the row's own live `waiting-approval`
//   status, and a row that met no gate counts in none of them — it is not a
//   refusal the operator never made.
// - A duration is only read off a run this device watched END. A live row has
//   no finish at all, and an `unresolved` row's finish is the moment this
//   client stopped polling rather than the moment the run finished
//   (`runs.ts:25-30`) — a span it cannot back, so a card shows no duration
//   rather than one that is really time-to-app-close or time-to-give-up. The
//   rule is `watchedRunSpanMs`, shared with the run card that prints a single
//   run's span, so the two surfaces cannot drift.
//
// These cards are observations of runs this device saw — a run started from
// the desktop or the TUI never reaches this list at all. The surface owes that
// sentence once, in its footer; nothing here may word a count as a
// gateway-side total.
//
// The window line names the cap the persistence layer enforces, imported from
// it rather than retyped, so the bound in the copy cannot drift from the bound
// on the list it describes.

import { formatDuration } from '@/lib/format';
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
 * The approval pressure one card's own rows recorded (D3's Build 1,
 * `FUTURE-ITEMS.md:805-806`: "approvals requested vs granted"). A request is
 * visible on a row two ways and both are needed: the decision the operator
 * made, written onto the row the moment the run left `waiting-approval`
 * (`approved`, gateway-provider.tsx:2217), and a request with no answer yet,
 * which is the row's own live status (`waiting-approval`, :2207). A row that
 * never met a gate carries neither, so it counts in none of these — never as a
 * refusal the operator did not make.
 */
export type ScorecardApprovals = {
  /** Every approval this card's rows asked for: the decided ones plus the waits. */
  asked: number;
  /** Decisions that let the run continue. */
  granted: number;
  /** Decisions that stopped it. */
  denied: number;
  /** Asked and never answered — the run is still blocked on the operator. */
  pending: number;
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
 * The span this device watched one run END on — the only duration any surface
 * may claim — or `null` when no read here can back one.
 *
 * `medianRunMs` folds over this and `RunCard` prints its answer, so a Bot's
 * card and a single run's card claim a duration by one rule rather than two:
 * - Only `complete`, `failed` and `cancelled` are timeable. A live row has no
 *   finish at all, and an `unresolved` row is out even though it is settled:
 *   it means the client stopped watching, so its finish is when polling gave
 *   up rather than when the run ended (`runs.ts:25-30`). That span is a lower
 *   bound, and a lower bound is not a run time.
 * - A finish past `now` is a placeholder rather than an end this device
 *   reached, and a finish at or before its own start is no span at all — the
 *   same discipline `buildHomeBriefing` applies to a finish that lies past its
 *   clock (`briefing.ts:47-49`).
 * - A `startedAt`/`finishedAt` a read cannot trust as a number is not a span
 *   either, so a half-shaped row cannot put a `NaN` into the answer.
 *
 * `now` is injectable for tests; in production it is the caller's own clock at
 * the moment it reads. A caller that prints this answer as a duration owed the
 * reader a span this device watched end, and the rule lives here so it cannot
 * drift from the fold that already decides it.
 */
export function watchedRunSpanMs(run: ActivityRun, now: number = Date.now()): number | null {
  if (run.status !== 'complete' && run.status !== 'failed' && run.status !== 'cancelled') return null;
  const { startedAt, finishedAt } = run;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null;
  if (typeof finishedAt !== 'number' || !Number.isFinite(finishedAt)) return null;
  if (finishedAt > now) return null;
  const span = finishedAt - startedAt;
  if (span <= 0) return null;
  return span;
}

/**
 * The median span this card's runs took (D3's Build 1, `FUTURE-ITEMS.md:804-805`),
 * folded over `watchedRunSpanMs` — the one rule for which rows a duration may
 * be claimed from. A card with nothing it can time answers `null` rather than
 * `0` — a Bot whose runs this device never timed must not read as one whose
 * runs took no time. An odd count answers with its middle span, an even one
 * with the midpoint of its two middle spans.
 */
export function medianRunMs(runs: readonly ActivityRun[], now: number = Date.now()): number | null {
  const spans: number[] = [];

  for (const run of runs) {
    const span = watchedRunSpanMs(run, now);
    if (span !== null) spans.push(span);
  }

  if (spans.length === 0) return null;
  spans.sort((a, b) => a - b);
  const middle = spans.length >> 1;
  if (spans.length % 2 === 1) return spans[middle];
  return Math.round((spans[middle - 1] + spans[middle]) / 2);
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
 * The approval pressure a card's rows recorded, by the one rule that separates
 * an answer from a wait: a row is pending while its own status says the run is
 * still blocked on the operator, and otherwise counts the decision written on
 * it. Only a real boolean is a decision — a value that is merely truthy is a
 * row this module cannot read as either, the same discipline `scorecardBotId`
 * applies to an id.
 *
 * The rows are the caller's own, so a card's pressure is folded from the runs
 * that card counted and never from another Bot's.
 */
export function scorecardApprovals(runs: readonly ActivityRun[]): ScorecardApprovals {
  const approvals: ScorecardApprovals = { asked: 0, granted: 0, denied: 0, pending: 0 };

  for (const run of runs) {
    if (run.status === 'waiting-approval') {
      approvals.pending += 1;
    } else if (run.approved === true) {
      approvals.granted += 1;
    } else if (run.approved === false) {
      approvals.denied += 1;
    } else {
      // A row that never met a gate: no decision and no wait, so it is not an
      // approval at all rather than one nobody answered.
      continue;
    }
    approvals.asked += 1;
  }

  return approvals;
}

/**
 * A card's one approval line — the pressure its own rows recorded, e.g.
 * `2 of 3 approvals granted · 1 waiting on you` — or nothing at all.
 *
 * The rate is stated over the approvals the operator ANSWERED, never over the
 * ones merely asked for: a request nobody has decided is not a refusal, and
 * `0 of 3 granted` for three waits would read as three decisions that were
 * never made. Every count still appears beside the rate rather than being
 * replaced by it, and a card whose rows met no gate says nothing rather than
 * `0 of 0 granted`.
 */
export function scorecardApprovalCopy(approvals: ScorecardApprovals): string {
  if (approvals.asked <= 0) return '';

  const decided = approvals.granted + approvals.denied;
  const parts: string[] = [];
  if (decided > 0) {
    parts.push(`${approvals.granted} of ${decided} approval${decided === 1 ? '' : 's'} granted`);
  }
  if (approvals.pending > 0) {
    parts.push(`${approvals.pending} waiting on you`);
  }
  return parts.join(' · ');
}

/**
 * A card's one duration line — the median span its own runs ended on, e.g.
 * `Median run 3:42` — or nothing at all. `null` is `medianRunMs`'s answer when
 * no row could back a span, and the card then shows its counts alone: a `0:00`
 * would read as a Bot whose runs took no time at all rather than as one this
 * device never timed. The figure is formatted by the shared duration
 * formatter, the same one an elapsed run card uses.
 */
export function scorecardDurationCopy(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return '';
  return `Median run ${formatDuration(ms)}`;
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
