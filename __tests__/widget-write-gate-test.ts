// Item 4d: the widget's write gate.
//
// The provider's write effect fires on every change to the facts the snapshot
// composes from — a start, an approval wait, a decision, a settle, a disconnect
// settle — and every fire rewrites the widget even when the visible card would
// read exactly the same. The gate answers the pure question: SHOULD this
// snapshot be written? Only three reasons to write: nothing written yet, the
// visible card would change, or the five-minute floor (a stamp kept honest is
// worth a rewrite even when nothing else moved).
//
// The stamp itself is deliberately NOT part of the comparison (it would force a
// write on every fire) but the approvals count IS, even where the lines mask it.

import type { GlanceableSnapshot } from '@/lib/widget/snapshot';
import {
  WIDGET_WRITE_FLOOR_MS,
  widgetSnapshotSignature,
  widgetWriteGate,
  type WidgetWriteGateState,
} from '@/lib/widget/widget-write-gate';

const NOW = 1757400000000;

function snapshot(overrides: Partial<GlanceableSnapshot> = {}): GlanceableSnapshot {
  return {
    status: 'connected',
    runsInFlight: 0,
    approvalsPending: 0,
    writtenAt: NOW,
    ...overrides,
  };
}

const stateFor = (snapshot: GlanceableSnapshot): WidgetWriteGateState => ({
  signature: widgetSnapshotSignature(snapshot),
  writtenAt: snapshot.writtenAt,
});

describe('widgetSnapshotSignature', () => {
  test('two snapshots the card would word identically share a signature', () => {
    // Only the stamp moves between these; a rewrite would change nothing read.
    expect(widgetSnapshotSignature(snapshot({ writtenAt: NOW }))).toBe(
      widgetSnapshotSignature(snapshot({ writtenAt: NOW + 12345 })),
    );
  });

  test('snapshots the card would word differently do not share one', () => {
    const base = widgetSnapshotSignature(snapshot());
    expect(widgetSnapshotSignature(snapshot({ status: 'disconnected' }))).not.toBe(base);
    expect(widgetSnapshotSignature(snapshot({ runsInFlight: 1 }))).not.toBe(base);
    expect(widgetSnapshotSignature(snapshot({ approvalsPending: 1 }))).not.toBe(base);
    expect(widgetSnapshotSignature(snapshot({ lastResult: 'wrote 3 files' }))).not.toBe(base);
    expect(widgetSnapshotSignature(snapshot({ routineAlerts: { late: 1, failing: 1 } })))
      .not.toBe(base);
  });

  test('the approvals count is its own term, not only a word in the work line', () => {
    // runsInFlight 1 reads "1 run in flight" vs "1 run waiting on your
    // approval", so the lines already move — but the signature carries the
    // count directly, so a future line change cannot silently unwatch it.
    const withApproval = snapshot({ runsInFlight: 1, approvalsPending: 1 });
    expect(widgetSnapshotSignature(withApproval)).not.toBe(
      widgetSnapshotSignature(snapshot({ runsInFlight: 1 })),
    );
  });
});

describe('widgetWriteGate', () => {
  test('the first call always writes, however quiet the snapshot is', () => {
    const gate = widgetWriteGate(null, snapshot(), NOW);
    expect(gate.write).toBe(true);
    expect(gate.last).toEqual({ signature: widgetSnapshotSignature(snapshot()), writtenAt: NOW });
  });

  test('the same visible card inside the five-minute floor is not rewritten', () => {
    const last = stateFor(snapshot());
    const gate = widgetWriteGate(last, snapshot({ writtenAt: NOW + 1000 }), NOW + 1000);
    expect(gate.write).toBe(false);
    // A refused write leaves the recorded last-write exactly as it was.
    expect(gate.last).toBe(last);
  });

  test('a changed card is written however recently the last one went out', () => {
    const last = stateFor(snapshot());
    const changed = snapshot({ runsInFlight: 2, writtenAt: NOW + 500 });
    const gate = widgetWriteGate(last, changed, NOW + 500);
    expect(gate.write).toBe(true);
    expect(gate.last).toEqual({ signature: widgetSnapshotSignature(changed), writtenAt: NOW + 500 });
  });

  test(`an unchanged card is rewritten after the ${WIDGET_WRITE_FLOOR_MS / 60000}-minute floor, and only after it`, () => {
    const last = stateFor(snapshot());
    const quiet = snapshot({ writtenAt: NOW + 4 * 60 * 1000 });
    // One tick shy of the floor: still held.
    expect(widgetWriteGate(last, quiet, NOW + WIDGET_WRITE_FLOOR_MS - 1).write).toBe(false);
    // At the floor: the stamp may say it is stale.
    const atFloor = widgetWriteGate(last, quiet, NOW + WIDGET_WRITE_FLOOR_MS);
    expect(atFloor.write).toBe(true);
    // The floor's write re-arms the clock from the moment it fires, not the
    // snapshot's own stamp.
    expect(atFloor.last).toEqual({ signature: widgetSnapshotSignature(quiet), writtenAt: NOW + WIDGET_WRITE_FLOOR_MS });
  });

  test('a snapshot the gate cannot read is still a write, never a crash', () => {
    const unreadable = snapshot({ status: 'pairing' as never, approvalsPending: Number.NaN });
    const gate = widgetWriteGate(null, unreadable, NOW);
    expect(gate.write).toBe(true);
    expect(Number.isFinite(widgetSnapshotSignature(unreadable as never).length)).toBe(true);
  });

  test('the gate handes a malformed recorded state as nothing written', () => {
    const gate = widgetWriteGate(
      { signature: '', writtenAt: Number.NaN } as WidgetWriteGateState,
      snapshot(),
      NOW,
    );
    // Not a real last write: a first call in every way that matters.
    expect(gate.write).toBe(true);
  });
});
