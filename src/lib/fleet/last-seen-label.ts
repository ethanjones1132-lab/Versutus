/**
 * The constellation screen's honest labels — one pure fold per line the map
 * can say about a gateway, so a screen never invents wording of its own.
 *
 * The two truth classes come from `constellationNodeClass`, the same fold the
 * map's every other word rides.
 */

import type { ConstellationTruth } from './constellation-model';

/**
 * What a node's status side says. The class chooses between exactly two
 * states, the fleet's own vocabulary:
 * - `live`: the class bell the home hero already rings, and nothing else.
 * - `saved`: the honest saved answer. Never a health claim the client
 *   cannot back — the reachability verdict rides beside it, not inside it.
 */
export function constellationStatusCopy(truth: ConstellationTruth): string {
  return truth === 'live' ? 'Connected' : 'Saved';
}

/**
 * The "last seen" line the reachability record itself earns with its own
 * `checkedAt` — never a timestamp the map invents, and never a stamp when the
 * wave has not reached this gateway. The verdict word is the probe wave's
 * own state, passed through un-reworded, so a status noun means the same
 * thing on the map it does on Home.
 */
export function lastSeenCopy(record: {
  state: string;
  checkedAt?: number;
}): string | undefined {
  return record.checkedAt !== undefined
    ? `${record.state}, last seen ${describeTime(record.checkedAt)}`
    : undefined;
}

/** A stamp asked for the words, not the clock. */
function describeTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export type { ConstellationTruth };
