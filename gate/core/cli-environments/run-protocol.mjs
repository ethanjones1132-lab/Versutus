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

  async function* stream() {
    let index = 0;
    while (true) {
      while (index < events.length) {
        const event = events[index];
        index += 1;
        yield event;
        if (/^run\.(completed|failed|cancelled)$/.test(event.type)) return;
      }
      if (terminal) return;
      await new Promise((resolve) => waiters.push(resolve));
    }
  }

  return { emit, stream, events: () => events.slice() };
}
