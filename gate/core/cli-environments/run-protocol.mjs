/**
 * Upper bound on one run's retained in-memory events. A chatty CLI can emit
 * tens of thousands of run.output frames, and a log that grew with the task
 * kept every one of them for the life of the Gate. The disk archive receives
 * all of them through onEmit regardless; what is capped here is the in-memory
 * replay buffer. The first event and the terminal verdict are never dropped —
 * they are what identifies the run and how it ended — so the surplus is taken
 * from the middle.
 */
const MAX_RETAINED_EVENTS = 5000;

const TERMINAL = /^run\.(completed|failed|cancelled)$/;

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
  let terminal = events.some((event) => TERMINAL.test(event.type));
  // How many events the retention cap has taken off the front, so a
  // subscriber parked mid-run resumes at the event it never saw rather than
  // `dropped` events further along — or off the end of the log.
  let dropped = 0;

  function retain() {
    const excess = events.length - MAX_RETAINED_EVENTS;
    if (excess <= 0) return;
    // Index 0 and the last event stay: the run's first event and its verdict.
    const take = Math.min(excess, Math.max(0, events.length - 2));
    if (take <= 0) return;
    events.splice(1, take);
    dropped += take;
  }

  retain();

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
    retain();
    if (TERMINAL.test(event.type)) {
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
    let seenDropped = dropped;
    let delivered = 0;
    // The cap can take events off the front while this generator is parked (or
    // while its consumer is handling one), so the position is re-based against
    // the number dropped before every read. A subscriber that fell further
    // behind than the cap removed cannot get those events back, so anything
    // already delivered is skipped by sequence rather than replayed.
    const takeNext = () => {
      const taken = dropped - seenDropped;
      seenDropped = dropped;
      index = Math.max(0, index - taken);
      while (index < events.length) {
        const event = events[index];
        index += 1;
        if (event.sequence <= delivered) continue;
        delivered = event.sequence;
        return event;
      }
      return null;
    };
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
        if (released) return;
        const event = takeNext();
        if (event) {
          yield event;
          if (TERMINAL.test(event.type)) return;
          continue;
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

  return {
    emit,
    stream,
    events: () => events.slice(),
    // The retained log's last event, without copying the log to find it: the
    // runs list asks this of every run it summarizes.
    lastEvent: () => events.at(-1) ?? null,
    pendingWaiters,
  };
}
