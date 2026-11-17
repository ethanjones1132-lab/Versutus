import type { ActivityCoverage } from '@/lib/gateway/activity-feed';

// ─── One backend's routines coverage, in words ─────────────────────────────
//
// The Gate reports what it could not read as a semicolon-joined list, and the
// list used to land on screen verbatim. Two facts hide in that list and they
// are not the same: a Bot with no home yet is simply not set up, while a
// backend that really failed is the one red line. So the line carries a count
// and at most one short reason — never the list.

export type RoutineCoverageLine = {
  /** The visible line, without the backend's label in front of it. */
  text: string;
  /** A real read failure: the only coverage word that goes red. */
  failed: boolean;
};

/** One per-Bot home that could not be read: the Gate's word for "not set up". */
const UNSET_BOT = /^bots?\b.+\bcould not be read\.?$/i;
/** The same fact said plainly, in case the Gate words it that way. */
const SETUP_WORD = /\b(?:not|isn't|aren't|never)\s+set\s+up\b/i;
/** The roster itself failing to read is a real failure, not a Bot named roster. */
const ROSTER_READ = /^bot\s+roster\b/i;
/** What every per-Bot read failure says, in full. */
const BOT_VERDICT = 'could not be read';

/** "1 routine" / "3 routines" — counted the way a person would say it. */
function routineCountLabel(count: number): string {
  return count === 1 ? '1 routine' : `${count} routines`;
}

/** The Bots that are simply not set up yet. Neutral, never a failure. */
export function unsetBotsLabel(count: number): string {
  return count === 1 ? "1 Bot isn't set up yet" : `${count} Bots aren't set up yet`;
}

function splitReasons(error: string | undefined): string[] {
  if (!error) return [];
  return error
    .split(';')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 0);
}

function isUnsetBot(part: string): boolean {
  if (ROSTER_READ.test(part)) return false;
  return UNSET_BOT.test(part) || SETUP_WORD.test(part);
}

/**
 * A trailing "Bot anvil" / "Bot anvil could n" is the Gate's 160-character cap
 * cutting its repeated per-Bot line short — one more Bot that is not set up,
 * not a sentence whose reason is a single word.
 */
function isCutOffBot(part: string): boolean {
  if (ROSTER_READ.test(part)) return false;
  const match = /^bots?\s+(.+)$/i.exec(part);
  if (!match) return false;
  const words = (match[1] ?? '').trim().split(/\s+/);
  if (words.length === 1) return (words[0] ?? '').length > 0;
  return BOT_VERDICT.startsWith(words.slice(1).join(' '));
}

/** Split the Gate's list into setup counts and the real reasons that remain. */
function classifyReasons(parts: readonly string[]): { unset: number; reasons: string[] } {
  let unset = 0;
  const reasons: string[] = [];
  parts.forEach((part, index) => {
    if (isUnsetBot(part) || (index === parts.length - 1 && isCutOffBot(part))) {
      unset += 1;
    } else {
      reasons.push(part);
    }
  });
  return { unset, reasons };
}

/** Keep a real reason to one sentence the caption line can hold. */
function firstSentence(reason: string): string {
  const flat = reason.replace(/\s+/g, ' ').trim();
  const cut = /^(.+?[.!?])\s+[A-Z0-9]/.exec(flat);
  return cut ? cut[1] : flat;
}

/**
 * One backend's coverage sentence: a count and at most one short reason.
 *
 * A backend that failed never prints a count — the Gate said nothing about its
 * routines, and "0 routines" would be a claim it never made. If the only thing
 * wrong is that Bots are not set up yet, even a failed status stays neutral.
 */
export function routineCoverageLine(coverage: ActivityCoverage, count: number): RoutineCoverageLine {
  if (coverage.status === 'unavailable') {
    return { text: 'not supported here', failed: false };
  }
  if (coverage.status === 'complete') {
    return { text: count > 0 ? routineCountLabel(count) : 'none', failed: false };
  }

  const parts = splitReasons(coverage.error);
  const { unset, reasons: rawReasons } = classifyReasons(parts);
  const reasons = rawReasons.map(firstSentence);
  const setup = unset > 0 ? unsetBotsLabel(unset) : undefined;

  if (coverage.status === 'failed') {
    const reason = reasons[0];
    if (!reason) {
      return setup ? { text: setup, failed: false } : { text: 'could not be read', failed: true };
    }
    return { text: reason, failed: true };
  }

  const bits = [
    routineCountLabel(count),
    setup,
    reasons[0] ?? (parts.length === 0 ? 'some could not be read' : undefined),
  ].filter((bit): bit is string => Boolean(bit));
  return { text: bits.join(' · '), failed: false };
}
