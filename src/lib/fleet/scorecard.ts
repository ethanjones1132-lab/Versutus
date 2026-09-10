// ─── Bot scorecards ───────────────────────────────────────────────
// D3's per-Bot track record (FUTURE-ITEMS.md §D3 Build 1): fold the run rows
// this device persisted into one card per Bot. Pure — the Activity surface
// reads the provider's runs and calls this; nothing here touches storage, a
// gateway, or a renderer.
//
// Honesty rules this fold enforces, each one a way a count could lie:
// - A cancelled run is not a failure. The operator stopped it, so it gets its
//   own count rather than inflating a failure rate it never earned — and the
//   same rule keeps it out of the success rate's denominator, where it would
//   depress a share it did not earn either. An `unresolved` run is out of that
//   denominator too: the fate never reached this device, so it is neither a
//   success nor a failure, and a card with nothing decided states no rate at
//   all rather than a percentage nothing backs.
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
// - A routine verdict is the gateway's own, read through `describeCronHealth`
//   and never re-worded here: a job whose name carries no Bot is attributed to
//   nobody rather than guessed into a card, and the count and the verdict stay
//   their own part of a card's line — so a gateway-side number can never be
//   read as one of the run-derived counts.
// - A spend number is the spend read's own (`readBotSpend`, P5) and is merged
//   onto a card by the id rule above, never re-derived here: a card the read
//   holds no row for says nothing about spend, and a row whose read failed
//   keeps the read's own unread wording rather than becoming a zero.
// - A card's one line is composed HERE, not by the surface, and it is composed
//   to a budget: the row that draws it gives it one clipped line, so six facts
//   cannot all survive a phone. Facts are dropped whole and least-important
//   first, never cut — a number clipped mid-figure is a number read wrong. And
//   because that row announces the string it draws, the facts it cannot fit are
//   dropped from what a screen reader reads too; the card hands it
//   `scorecardCardAnnouncement` instead, the same facts with no budget, so an
//   operator who cannot see the line is told what the card counted.
// - A card that is DRAWN as the filtered one says so. That state is not a fact
//   about the Bot's runs, so it is on neither the drawn line nor the folds:
//   the caller that knows it is showing — the surface, which computes it for
//   the badge — hands it to `scorecardCardAnnouncement`, which appends
//   `SCORECARD_SHOWING_COPY` to the sentence, and a card that is not showing
//   says nothing about it. The word the badge draws is `SCORECARD_SHOWING_LABEL`,
//   held here beside that sentence so one state has one vocabulary.
// - A card's hint is what its tap does NEXT, which is a different question from
//   the state above, and this is the one card whose tap has nothing left to do:
//   re-applying the filter the list already carries shows no new list, so
//   `scorecardCardHint` hands that card no hint at all rather than the promise
//   every other card can keep. The state is said once, by the announcement, and
//   never a second time as an action.
// - The same card is drawn without its chevron (`scorecardCardChevron`), for
//   the same reason said to the eye: the trailing chevron is the kit's visual
//   for a surface this way, and this card's tap opens none. Every other card
//   keeps the chevron it already had.
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
import { describeCronHealth, type CronHealth, type CronJob } from '@/lib/gateway/cron';
import { parseRoutineName } from '@/lib/gateway/routines';
import { ACTIVITY_RUNS_PERSIST_CAP } from '@/lib/gateway/session-persistence';
import { botSpendRowCopy, type BotSpendRow } from '@/lib/gateway/spend-report';
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
  /**
   * This Bot's spend, once `withSpend` has merged P5's read onto the card.
   * Absent otherwise: a card the read holds no row for prints no spend at all
   * rather than a zero it never read.
   */
  spend?: BotSpendRow;
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
 * One Bot's routines, summarized (D3's Build 1, `FUTURE-ITEMS.md:806-807`:
 * "routine reliability from cron health"). This is gateway-side work, not a run
 * this device recorded, so it is kept its own part of a card's line: the count
 * below is routines the host reports, never a count of runs.
 */
export type ScorecardRoutineHealth = {
  /** How many of this Bot's routines the read held. */
  routines: number;
  /** The worst verdict among them — `describeCronHealth`'s own words. */
  verdict: CronHealth;
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
 * The share of a card's runs that reached a verdict and succeeded (D3's Build
 * 1, `FUTURE-ITEMS.md:803-804`: "success rate (`complete` / terminal statuses").
 *
 * The verdicts are the two this device can back: `complete` over the decided
 * pair, `complete + failed`. A `cancelled` run is the operator's own stop — the
 * spec's "a cancelled run is not a failure" — and an `unresolved` run is a fate
 * this device never learned (`runs.ts:25-30`), so neither is a failure and
 * neither may depress a share it did not earn. The same discipline
 * `scorecardApprovalCopy` applies to the requests nobody answered; both counts
 * stay visible in the fates line, this rate only divides two of them. Runs
 * still in flight reached no verdict at all.
 *
 * `null` when nothing reached a verdict — a card of stopped runs, of runs whose
 * fate never came back, or of runs still going has no rate to state, and `0`
 * there would read as a Bot that never once succeeded.
 */
export function scorecardSuccessRate(fates: ScorecardFates): number | null {
  const { complete, failed } = fates;
  if (!Number.isFinite(complete) || !Number.isFinite(failed)) return null;
  if (complete + failed <= 0) return null;
  return complete / (complete + failed);
}

/**
 * A card's one rate line, e.g. `75% success` — or nothing at all.
 *
 * The share is rounded to whole percent, never to a certainty: a card with a
 * failure in it never reads `100%`, and a card with a success in it never reads
 * `0%`, because either would claim a track record those runs did not earn. The
 * counts are the fates line's, printed once, so this part restates none of them
 * and a card with nothing decided says nothing rather than `0%`.
 */
export function scorecardSuccessCopy(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return '';
  const pct = Math.round(rate * 100);
  if (pct >= 100 && rate < 1) return '99% success';
  if (pct <= 0 && rate > 0) return '1% success';
  return `${pct}% success`;
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
 * Worst-first, and this is the cron module's own discipline rather than a new
 * one: a failure is what the operator has to act on, a cooldown is the host
 * stopping the next run, a verdict the host cannot give outranks a healthy one
 * because this repo reads absent data as UNKNOWN rather than as a reassuring
 * claim (`cron.ts:7-10`), and last comes a routine that is off on purpose —
 * which `describeCronHealth` refuses to call unhealthy.
 */
const ROUTINE_TONE_RANK: readonly CronHealth['tone'][] = ['error', 'warn', 'unknown', 'ok', 'off'];

/**
 * The gateway's own job list, grouped by the Bot each job's name carries
 * (`[bot:<name>]` — the convention `routineName` writes and `parseRoutineName`
 * reads), with every group summarized by its worst verdict.
 *
 * A job whose name carries no Bot is attributed to nobody: it shares the
 * unattributed bucket rather than being guessed into some Bot's card, the same
 * rule `buildScorecards` applies to a run row with no `botId`. A Bot the read
 * holds no jobs for gets no entry at all, so a surface says nothing about its
 * routines rather than `0 routines` — which would read as a Bot whose routines
 * are all quiet.
 */
export function scorecardRoutineHealth(
  jobs: readonly CronJob[],
): Map<string | null, ScorecardRoutineHealth> {
  const groups = new Map<string | null, ScorecardRoutineHealth>();

  for (const job of jobs) {
    const botId = scorecardBotId(parseRoutineName(job.name ?? '').botId);
    const verdict = describeCronHealth(job);
    const group = groups.get(botId);
    if (!group) {
      groups.set(botId, { routines: 1, verdict });
      continue;
    }
    group.routines += 1;
    // Ties keep the verdict already held, so one read folds to one answer.
    if (ROUTINE_TONE_RANK.indexOf(verdict.tone) < ROUTINE_TONE_RANK.indexOf(group.verdict.tone)) {
      group.verdict = verdict;
    }
  }

  return groups;
}

/**
 * A card's one routine line — the gateway's verdict on this Bot's routines
 * beside how many it covered, e.g. `2 routines · ok` — or nothing at all when
 * the read attributed no routine to this card.
 *
 * The count names what it counts: a bare `2 · ok` would read as two of the
 * card's runs, and the verdict is in `describeCronHealth`'s own words so the
 * card and the Routine surfaces cannot describe one host state two ways. A Bot
 * with no routines prints nothing rather than `0 routines`.
 */
export function scorecardRoutineCopy(health: ScorecardRoutineHealth | undefined): string {
  if (!health || health.routines <= 0) return '';
  return `${health.routines} routine${health.routines === 1 ? '' : 's'} · ${health.verdict.label}`;
}

/**
 * The cards with each Bot's spend merged on (D3's Build 1, `FUTURE-ITEMS.md:807`:
 * "spend from P5"). The rows are P5's own read — `readBotSpend` answers them and
 * the surface hands them here — so this fold only decides which card owns which
 * row, and no number is ever derived a second time.
 *
 * The two folds meet on the id rule this module already applies
 * (`scorecardBotId`): a row whose id is present but empty is the unattributed
 * row and lands on the unattributed card rather than on some Bot. The cards
 * decide the list, so a Bot the spend read holds but this device has no runs
 * for gets no card — an empty card would read as a Bot that fails at nothing —
 * and a card the read holds no row for carries no `spend` field at all, so a
 * surface prints nothing rather than a zero it never read.
 */
export function withSpend(
  cards: readonly BotScorecard[],
  rows: readonly BotSpendRow[],
): BotScorecard[] {
  const spendByBot = new Map<string | null, BotSpendRow>();
  for (const row of rows) {
    spendByBot.set(scorecardBotId(row.botId), row);
  }

  return cards.map((card) => {
    const spend = spendByBot.get(scorecardBotId(card.botId));
    return spend ? { ...card, spend } : card;
  });
}

/**
 * A card's spend, in the words the Spend screen already prints — or nothing at
 * all. `botSpendRowCopy` is the row's one wording, reused rather than
 * re-authored, so a card and P5's per-Bot section cannot describe one read two
 * ways: a costed row carries its tokens, its cost and the basis they are
 * claimed on, and a read that failed keeps its own unread line instead of a
 * zero. A card with no spend row says nothing.
 */
export function scorecardSpendCopy(spend: BotSpendRow | undefined): string {
  if (!spend) return '';
  return botSpendRowCopy(spend);
}

/**
 * The facts one card's line can carry, each already in this module's own words
 * — the folds above decide each one, and `scorecardCardLine` decides which of
 * them one clipped line holds. An empty string is a fact this card does not
 * hold, and takes no room on the line at all.
 */
export type ScorecardCardParts = {
  /** The counts — the one fact a card never drops. */
  fates: string;
  success: string;
  timed: string;
  approvals: string;
  routines: string;
  spend: string;
};

/**
 * The order a card's line reads in — the order it has read in since each of
 * those folds shipped, so a card with room looks exactly as it always did.
 */
const SCORECARD_LINE_ORDER: readonly (keyof ScorecardCardParts)[] = [
  'fates',
  'success',
  'timed',
  'approvals',
  'routines',
  'spend',
];

/**
 * What a card gives up first when its one line cannot hold everything, least
 * important first. The reason is whose fact each one is rather than how long it
 * is: a card is a record of the runs this device saw, so the facts ABOUT those
 * runs — the counts, the rate they earned, the span they ended on, the
 * approvals they recorded — outrank the two another surface owns. The spend's
 * own home is the Spend screen, which prints it in these same words beside the
 * cap it was read at; the routine verdict's home is the Routine surfaces, which
 * is where a host state belongs. Within the run-derived facts the softer one
 * goes first: a median span this device watched is the least actionable thing
 * on the card, while an approval recap can name a request still waiting on the
 * operator — the only fact here the operator is asked to act on.
 *
 * The counts are not on this list at all: a card that cannot print what it
 * counted prints nothing worth printing.
 */
const SCORECARD_LINE_DROP_ORDER: readonly (keyof ScorecardCardParts)[] = [
  'spend',
  'routines',
  'timed',
  'approvals',
  'success',
];

/**
 * The room a card's one line has, in characters.
 *
 * `ListRow` draws it as ONE caption line (`numberOfLines={1}`,
 * `src/components/ui/ListRow.tsx:88-95`) inside a row whose chevron, gaps and
 * trailing badge have already taken their share, so a line longer than the room
 * is not shortened by the renderer — it is CLIPPED, and the number it was in
 * the middle of is what the operator loses. This fold composes to a budget
 * instead and drops whole facts, so nothing is ever half-printed.
 *
 * The number is the narrowest state a card is drawn in — the card carrying the
 * `Showing` badge while the list above is filtered to it, which is the card the
 * operator is looking at — and it is an ESTIMATE from the repo's own spacing
 * and type tokens, not a measurement. A phone-width column, from
 * `src/constants/tokens.ts`: 390pt less the Activity list's own `Spacing.four`
 * gutter either side (48) and the card's `Spacing.three` padding (32) is 310pt;
 * the row's chevron (14) and its two `Spacing.three - 4` gaps leave 272pt; the
 * badge — a `micro` label with a dot and `Spacing.two` padding — takes roughly
 * 200pt more, leaving ~200pt. (The card the badge marks is the one card drawn
 * WITHOUT its chevron — `scorecardCardChevron` — so that narrowest state is a
 * little wider than this chain counts, which is the direction this budget errs
 * in.) A caption glyph at `Typography.caption.fontSize`
 * 13 advances about half an em, so ~200pt is about thirty characters — and the
 * budget is 36, deliberately a little over that arithmetic rather than at it.
 * The estimate stacks three guesses (a phone's width, a glyph's advance, the
 * badge's own width) whose error is larger than a character or two, and the
 * counts and the rate they earned are the pair a card is FOR: a typical pair is
 * around 35 characters (`4 complete · 1 failed · 80% success`) and must survive
 * on a card. The budget is a parameter for exactly this reason: a surface that
 * can measure its own line hands its own number, and the rule below is the same
 * rule either way. Erring small costs the card a whole fact, which is the
 * failure this fold is here to CHOOSE; erring large clips one, which is the
 * failure it is here to stop.
 */
export const SCORECARD_CARD_LINE_MAX = 36;

/** The facts still held, joined in the order a card's line reads in. */
function composedLine(
  parts: ScorecardCardParts,
  held: ReadonlySet<keyof ScorecardCardParts>,
): string {
  return SCORECARD_LINE_ORDER.filter((part) => held.has(part))
    .map((part) => parts[part])
    .join(' · ');
}

/** Every fact this card holds — an empty string is a fact it does not. */
function heldFacts(parts: ScorecardCardParts): Set<keyof ScorecardCardParts> {
  return new Set(SCORECARD_LINE_ORDER.filter((part) => parts[part] !== ''));
}

/**
 * A card's one line, composed to a budget (D3's Build 3,
 * `FUTURE-ITEMS.md:811-812`): the facts that fit, in the order a card reads in,
 * with the rest dropped whole.
 *
 * `ListRow` gives this string one line and clips what it cannot fit, so a line
 * that cannot hold everything does not lose its tail gracefully — it loses a
 * figure mid-number, and a truncated count reads as a count. This fold drops
 * whole FACTS instead, least important first
 * (`SCORECARD_LINE_DROP_ORDER`), and its answer is never a fragment.
 *
 * `maxLength` is the room the line has; the default is
 * `SCORECARD_CARD_LINE_MAX`. Two rules hold at every budget: the counts are
 * never dropped — a card with room for nothing else still says what it counted,
 * budget or no budget, because the counts are the card — and no fact is
 * re-worded or re-derived, so every number printed is one of the folds' own.
 *
 * This is the line a card DRAWS. What a screen reader is told is
 * `scorecardCardAnnouncement`, which is this same set of facts with no budget:
 * `ListRow` announces a row with the string it draws, so a fact this fold could
 * not fit would otherwise be missing from the sentence as well as the pixels.
 */
export function scorecardCardLine(
  parts: ScorecardCardParts,
  maxLength: number = SCORECARD_CARD_LINE_MAX,
): string {
  const budget = Number.isFinite(maxLength) ? Math.max(0, Math.floor(maxLength)) : 0;
  // Start from every fact the card holds, then drop the least important one
  // still on the line until the answer fits. A room this fold cannot read is no
  // room at all, which composes the counts rather than everything.
  const held = heldFacts(parts);

  for (const part of SCORECARD_LINE_DROP_ORDER) {
    // The counts are never in the drop order; the size guard keeps a malformed
    // line (no counts at all) from composing to nothing.
    if (held.size <= 1 || composedLine(parts, held).length <= budget) break;
    held.delete(part);
  }

  return composedLine(parts, held);
}

/**
 * The word a card DRAWS when the run list above is filtered to it. It rides the
 * card's badge (`src/components/activity/scorecards-section.tsx`), which is a
 * VISUAL inside the row: `ListRow` announces the string it is handed, so a
 * badge marks a card for the eye alone. It lives here rather than on the
 * surface so the badge and the sentence a screen reader hears cannot end up
 * naming one state two ways.
 */
export const SCORECARD_SHOWING_LABEL = 'Showing';

/**
 * What a card's announcement appends when that card is the one the run list
 * above is filtered to — the one state a card is DRAWN in that its own line
 * cannot carry, and the only fact on the sentence that is not about the Bot's
 * runs. It begins with the badge's own word (`SCORECARD_SHOWING_LABEL`), and a
 * card that is not showing says nothing about it at all.
 */
export const SCORECARD_SHOWING_COPY = `${SCORECARD_SHOWING_LABEL} this Bot's runs in the list above`;

/**
 * The whole card as one sentence — the card's own title and EVERY fact it
 * holds, in the line's order, joined with no budget.
 *
 * This is what a card hands `ListRow` as its announcement. The row draws a
 * composed line (`scorecardCardLine`) and announces the string it draws — one
 * `<Text>` clipped to one line, with the same string in its
 * `accessibilityLabel` (`src/components/ui/ListRow.tsx:74`, `:88-95`) — so
 * without this fold a fact the budget dropped would be dropped from the
 * sentence a screen reader reads as well, and an operator who cannot see the
 * row would be told strictly less than one who can. The card's facts are a
 * count of the runs this device saw; a withheld one is not something the
 * announcement may quietly lose.
 *
 * The room a sentence has is not the room a caption line has, so there is no
 * budget here: the facts a card could not print are exactly the ones the
 * announcement is here to recover. The title is passed in already worded —
 * `scorecardBotLabel` for a card — so this fold re-words nothing, and the
 * title and the announcement cannot name a card differently.
 *
 * `showing` is the one state a card is DRAWN in that its own line cannot carry
 * — the run list above is filtered to this Bot — and it comes from the caller
 * that draws the card's badge, so the state the operator sees and the state the
 * sentence says are one computation. It is appended AFTER the whole card: it is
 * not a fact about this Bot's runs, so it takes no fact's place, and a card
 * that is not showing is announced exactly as it was before this state existed.
 */
export function scorecardCardAnnouncement(
  title: string,
  parts: ScorecardCardParts,
  showing = false,
): string {
  const line = composedLine(parts, heldFacts(parts));
  // A card holding no facts is its title alone, never a bare line and never a
  // nameless sentence.
  const card = line ? `${title}, ${line}` : title;
  return showing ? `${card}, ${SCORECARD_SHOWING_COPY}` : card;
}

/**
 * What a card's tap does NEXT, as the hint `ListRow` reads after a card's
 * announcement — the shipped affordance, unchanged, and never said about a
 * card it is not true of.
 *
 * This is the question the announcement above does not answer: that one says
 * the STATE (this card is drawn as the filtered one), this one says the ACTION
 * (the tap puts this Bot's runs in the list above). A hint that answers the
 * state's question again would tell the operator the same thing twice and
 * promise, in the imperative register, the action it cannot deliver — so the
 * two states have two answers, and only one of them is this string.
 *
 * It lives here rather than on the surface so the cards are worded in one
 * place: the surface hands the row `scorecardCardHint(showing)` and authors
 * nothing.
 */
export const SCORECARD_CARD_HINT = "Shows this Bot's runs in the list above";

/**
 * The hint a card carries, decided off the one `showing` the caller draws the
 * card's badge from.
 *
 * A card the list above is NOT filtered to promises what its tap does, which
 * is true of it: the tap filters the list to this Bot. A card that IS showing
 * has no action left on the row at all — its tap hands the tab the same bucket
 * the list already carries, so nothing above it changes — and the module's
 * answer for that state is therefore no hint: silence rather than a promise of
 * a list the tap cannot produce, and rather than the announcement's own
 * sentence said over again. A card that cannot say what its tap does says
 * nothing.
 */
export function scorecardCardHint(showing: boolean): string | undefined {
  return showing ? undefined : SCORECARD_CARD_HINT;
}

/**
 * Whether a card wears `ListRow`'s trailing chevron, decided off the one
 * `showing` the caller draws the card's badge from.
 *
 * The chevron is this kit's visual for "there is a surface this way" — the
 * affordance a card carries because tapping it walks the list above to that
 * Bot's runs — so a card the list above is ALREADY filtered to has no step left
 * for it to draw: its tap hands the tab the bucket the list already carries
 * (`onPress={() => onSelect({ botId: card.botId })}`,
 * `src/components/activity/scorecards-section.tsx`), and nothing above it
 * changes. The operator who can see would be promised exactly what
 * `scorecardCardHint` above stopped promising the operator who cannot, so that
 * one card is drawn without it.
 *
 * `true` is the answer every other card already wore: `ListRow` draws the
 * chevron whenever it has a press (`showChevron = chevron ?? !!onPress`,
 * `src/components/ui/ListRow.tsx:66`), which every card here has — so this fold
 * never ADDS a chevron, it decides which cards are handed one, and the surface
 * hands the row one expression rather than a literal of its own.
 */
export function scorecardCardChevron(showing: boolean): boolean {
  return !showing;
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
