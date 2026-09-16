// ─── The run a notification tap named ─────────────────────────────
// A tap on a run notice opens the Runs destination, and the destination
// applies the focus itself: the Bot filter is dropped so the named run's row
// is visible. What the tap promised was more than "it is on the list" —
// the fold here decides which row is *highlighted*, so the operator's eye is
// taken to the run the notice was about instead of asked to find it.
//
// Honesty rules:
// - A run this device does not hold highlights nothing. The filter-drop
//   behavior (the whole list readable) is separate from the highlight, and
//   stays: an absent id asks the destination to open, never to guess.
// - A repeated tap for the same run is the same highlight, not a fresh one —
//   the same pin `pendingRunFocus` makes about the request slot.
// - The highlight is self-clearing: the destination may retire it on an
//   operator scroll or interaction, so a stale ring never outlives its tap.

import type { ActivityRun } from '@/lib/gateway/runs';

/** The item types the Runs list folds, keyed exactly as runs.tsx keys them. */
export type RunListItem =
  | { kind: 'label'; id: string; text: string }
  | { kind: 'active'; id: string; run: ActivityRun }
  | { kind: 'finished'; id: string; run: ActivityRun };

/**
 * The item id a focus names, as the Runs list keys rows: a run row is keyed
 * by the run's id (`item.kind` is `active` or `finished`), and the section
 * labels are not rows the run could hide behind. Null when the named run is
 * not in the list.
 */
export function focusedRunItemId(
  items: readonly RunListItem[],
  focus: { runId: string },
): string | null {
  for (const item of items) {
    if (item.kind === 'active' || item.kind === 'finished') {
      if (item.id === focus.runId) return item.id;
    }
  }
  return null;
}
