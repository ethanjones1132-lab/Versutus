// ─── The elapsed-time copy a live call shows ───────────────────────────────
// A call left running in a pocket never said how long it had been going.
// The fold lives in the copy module so the words cannot drift from the
// banner that draws them, and so it is pinned without mounting a screen.

import {
  handsfreeElapsedCopy,
} from '@/lib/voice/handsfree-call-copy';

describe('the call’s elapsed time', () => {
  test('says minutes under the hour and folds hours in past one', () => {
    // Started at a round epoch so the arithmetic stays readable.
    const start = 1_000_000;
    expect(handsfreeElapsedCopy(start, start + 0)).toBe('running 0m');
    expect(handsfreeElapsedCopy(start, start + 59_000)).toBe('running 0m');
    expect(handsfreeElapsedCopy(start, start + 61_000)).toBe('running 1m');
    expect(handsfreeElapsedCopy(start, start + 3_600_000)).toBe('running 1h 0m');
    expect(handsfreeElapsedCopy(start, start + 3_661_000)).toBe('running 1h 1m');
    expect(handsfreeElapsedCopy(start, start + 7_325_000)).toBe('running 2h 2m');
  });

  test('is honest when the start time is unknown — never a zero duration', () => {
    // A call whose start this device never recorded must not read as "just
    // started"; silence is the only honest answer there.
    expect(handsfreeElapsedCopy(undefined, 1_000_000)).toBeNull();
  });

  test('the banner states an elapsed time only for an active call with a known start', () => {
    // The copy itself is humane by construction; the banner's own wiring is
    // pinned by the UI contract test.
    const start = 0;
    expect(handsfreeElapsedCopy(start, start)).toBe('running 0m');
  });
});
