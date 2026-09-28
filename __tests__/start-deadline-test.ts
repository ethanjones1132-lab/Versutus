// The one thing about the start budget nothing else exercises. Every timeout
// path in `handsfree-start-attempt` and in the provider proves the budget FIRES
// — but the budget is armed the moment the deadline is created, not the first
// time something is guarded, so a start that answers in 2 seconds has 43 of its
// 45 seconds still ticking. `dispose` is what ends that, and its contract is
// that a call which got home is never abandoned afterwards.
import { startDeadline } from '@/lib/voice/start-deadline';

describe('a disposed start budget is cleaned up, not merely unobserved', () => {
  test('the armed timer is gone, so a link that never answers is no longer abandoned', async () => {
    jest.useFakeTimers();
    try {
      const deadline = startDeadline(50);
      // Armed by the deadline's own construction, before a link is guarded.
      expect(jest.getTimerCount()).toBe(1);

      const abandoned = deadline.guard('the microphone prompt', new Promise<never>(() => {}));
      let rejected: unknown = null;
      void abandoned.catch((err: unknown) => {
        rejected = err;
      });

      // The whole point: a start that already settled must leave nothing armed
      // that can still fire into it.
      deadline.dispose();
      expect(jest.getTimerCount()).toBe(0);

      // Async on purpose: the rejection reaches the catch through a
      // `Promise.race`, so it needs the microtask queue drained, not just the
      // clock moved. A single `await Promise.resolve()` would still be pending
      // here and would pass with the cleanup broken.
      await jest.advanceTimersByTimeAsync(10_000);
      expect(rejected).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
