// ─── The widget's write gate ──────────────────────────────────────
// The pure half of item 4d (FUTURE-ITEMS.md §4): whether the next snapshot is
// worth a write at all. The provider's write effect fires on every change to
// the facts the snapshot composes from, and Android's Glance card redraws on
// every payload it is handed, so a fire whose card would read exactly the same
// is a rewrite the operator sees a fresh stamp for and nothing else.
//
// Three reasons to write, and only three:
// - nothing has been written yet (the gate has never accepted one),
// - the visible card would change — the lines `glanceableWidgetLines` draws
//   (minus the stamp, which changes on every write by design) plus the approval
//   count, folded from the same snapshot,
// - five minutes have passed since the last accepted write, so a frozen
//   connection cannot leave the card's stamp silently ageing.
//
// The gate decides WHETHER `writeWidgetSnapshot` is called: the seam, the lines
// and the Android payload are untouched. A refused write updates nothing — the
// last state stays the one the last ACCEPTED write recorded — so a refused
// write is retried on the next change rather than charged against the floor.

import { glanceableWidgetLines } from '@/lib/widget/widget-target';
import type { GlanceableSnapshot } from '@/lib/widget/snapshot';

/** How long an unchanged card may stand before the stamp is refreshed anyway. */
export const WIDGET_WRITE_FLOOR_MS = 5 * 60 * 1000;

/**
 * The last write the gate accepted: the visible card it drew, and when it went
 * out (the gate's own `now`, not the snapshot's stamp — the floor re-arms from
 * the moment of the write).
 */
export type WidgetWriteGateState = {
  signature: string;
  /** The gate's `now` at the accepted write; drives the five-minute floor. */
  writtenAt: number;
};

/** What the gate asked the gate to decide: write, and the state after. */
export type WidgetWriteGateDecision = {
  write: boolean;
  /** The state to hold afterwards; unchanged when the write is refused. */
  last: WidgetWriteGateState | null;
};

/**
 * The visible card in one string: the lines the target draws (stamp excluded —
 * it names the write moment and would force a write on every fire) plus the
 * approval count, which the work line words but a future line change could
 * reword away. Run rows, Bot destinations and privacy also drive the Android
 * card, even when these shared lines stay the same.
 */
export function widgetSnapshotSignature(snapshot: GlanceableSnapshot): string {
  const { written: _written, ...lines } = glanceableWidgetLines(snapshot, snapshot.writtenAt);
  return JSON.stringify({
    lines,
    approvals: snapshot.approvalsPending,
    runs: snapshot.runs ?? [],
    bots: snapshot.bots ?? [],
    redact: snapshot.redact === true,
  });
}

function acceptedState(state: WidgetWriteGateState | null): WidgetWriteGateState | null {
  return state && state.signature !== '' && Number.isFinite(state.writtenAt) ? state : null;
}

/**
 * Answer whether this snapshot should be written. `last` is what the gate
 * accepted at the previous write — `null` before the first — and `now` is the
 * moment of this decision, injectable like every other flag of the widget's
 * pure halves.
 */
export function widgetWriteGate(
  last: WidgetWriteGateState | null,
  snapshot: GlanceableSnapshot,
  now: number,
): WidgetWriteGateDecision {
  const accepted = acceptedState(last);
  const signature = widgetSnapshotSignature(snapshot);
  const next: WidgetWriteGateState = { signature, writtenAt: now };
  if (
    accepted === null ||
    accepted.signature !== signature ||
    now - accepted.writtenAt >= WIDGET_WRITE_FLOOR_MS
  ) {
    return { write: true, last: next };
  }
  return { write: false, last: accepted };
}
