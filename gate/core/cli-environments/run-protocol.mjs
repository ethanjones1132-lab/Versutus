/**
 * The per-run event log: an ordered, replayable record of everything that
 * happened to one run.
 *
 * - `events` seeds the log from an archive (a restarted Gate rebuilds a
 *   finished run's history so discovery + replay keep working); a seeded log
 *   starts at the loaded sequence and is terminal when its last event is.
 * - `onEmit` mirrors each freshly emitted event to a subscriber (the disk
 *   archive) without changing what the stream yields. A throwing subscriber
 *   must never break the run, so its errors are swallowed here.
 * - `stream(signal)` is the one way in, and the signal is how a subscriber that
 *   has left lets go: see the release note there.
 */
export function createEventLog(runId, { events: seeded, onEmit } = {}) {
  const events = seeded ? [...seeded] : [];
  const waiters = [];
  let sequence = events.length ? events.at(-1).sequence : 0;
  let terminal = events.some((event) => /^run\.(completed|failed|cancelled)$/.test(event.type));

  function emit(partial) {
    if (terminal) return null;
    sequence += 1;
    const event = {
      runId,
      sequence,
      timestamp: new Date().toISOString(),
      type: partial.type,
      payload: partial.payload ?? {},
    };
    events.push(event);
    if (/^run\.(completed|failed|cancelled)$/.test(event.type)) {
      terminal = true;
    }
    try {
      onEmit?.(event);
    } catch {
      // A persistence hiccup must never break the live run.
    }
    for (const waiter of waiters.splice(0)) waiter();
    return event;
  }

  async function* stream(signal) {
    let index = 0;
    let released = false;
    // A parked waiter is the only thing holding a subscription to a quiet run,
    // and a queued `return()` cannot take it: the loop re-parks at a fresh
    // await every time round, so a return waiting behind an in-flight `next()`
    // is never honoured and the waiter outlives the subscriber. The signal is
    // therefore the unsubscribe — it drops the waiter and wakes the generator so
    // this loop can end for real.
    let wake = null;
    const release = () => {
      if (released) return;
      released = true;
      if (!wake) return;
      const parked = waiters.indexOf(wake);
      if (parked !== -1) waiters.splice(parked, 1);
      wake();
    };
    if (signal?.aborted) return;
    signal?.addEventListener('abort', release, { once: true });
    try {
      for (;;) {
        while (index < events.length) {
          if (released) return;
          const event = events[index];
          index += 1;
          yield event;
          if (/^run\.(completed|failed|cancelled)$/.test(event.type)) return;
        }
        if (terminal || released) return;
        await new Promise((resolve) => {
          wake = () => { wake = null; resolve(); };
          waiters.push(wake);
        });
      }
    } finally {
      signal?.removeEventListener('abort', release);
      release();
    }
  }

  /**
   * How many subscribers are parked waiting for the next event. A released one
   * has to drop out of this: it is the only honest witness that a viewer who
   * left is no longer holding the run open.
   */
  function pendingWaiters() {
    return waiters.length;
  }

  return { emit, stream, events: () => events.slice(), pendingWaiters };
}
