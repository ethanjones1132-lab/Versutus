export function createEventLog(runId) {
  const events = [];
  const waiters = [];
  let sequence = 0;
  let terminal = false;

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
