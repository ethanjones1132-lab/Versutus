/**
 * Serialise "recompute everything from disk" into one run at a time with at
 * most one follow-up queued behind it.
 *
 * A reload builds a complete snapshot and the caller assigns it wholesale, so
 * two overlapping reloads finished out of order meant the one that read the
 * disk first assigned last: a provider created at the same moment as a
 * capability instance produced two reloads, and the manifest hid both new
 * entries for as long as the older snapshot stood. Runs here cannot overlap at
 * all, which makes that ordering unrepresentable rather than merely unlikely,
 * and every caller's answer comes from reads that began after it asked.
 *
 * @param {() => Promise<unknown>} compute
 * @returns {() => Promise<unknown>} reload, resolving with the newest state
 */
export function createSerialReload(compute) {
  let running = null;
  let queued = null;

  /** A promise plus the handles that settle it, so the run can be started later. */
  function defer() {
    const entry = {};
    entry.result = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    // The rejection is delivered to whoever awaits this run; the guard is only
    // here so a caller that walked away cannot turn it into an unhandled
    // rejection in the Gate's own process.
    entry.result.catch(() => undefined);
    return entry;
  }

  function start(entry) {
    running = entry;
    // Deferred by a turn of the loop on purpose: the reads behind this run's
    // answer have all started by the time it settles, and none of them began
    // before the caller that queued it asked.
    Promise.resolve()
      .then(compute)
      .then(
        (state) => settle(entry, () => entry.resolve(state)),
        (error) => settle(entry, () => entry.reject(error)),
      );
  }

  function settle(entry, finish) {
    const next = queued;
    queued = null;
    running = null;
    finish();
    // A rejected run reports to the callers waiting on it and moves the queue
    // on, so one unreadable directory does not wedge every later reload.
    if (next) start(next);
  }

  return function reload() {
    if (!running) {
      start(defer());
      return running.result;
    }
    // A run is in flight, so its reads began before this call asked: N callers
    // that overlap cost two computations, not N, because they all share the one
    // follow-up queued behind it.
    if (!queued) queued = defer();
    return queued.result;
  };
}

/**
 * Collapse a burst of requests into one run, a moment after the last of them.
 *
 * Readiness follows real turns, and turns arrive in bursts: a batch of chats, or
 * a phone retrying, would otherwise rebuild the whole state once each. The
 * timer is unreferenced so a pending reload is never a reason for the Gate to
 * stay alive, and a failed run is swallowed because there is nobody left to
 * report it to and the next request will try again.
 *
 * @param {() => Promise<unknown>} reload
 * @param {{ delayMs?: number }} [options]
 * @returns {() => void}
 */
export function createDebouncedReload(reload, { delayMs = 1000 } = {}) {
  let timer = null;
  return () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      Promise.resolve().then(reload).catch(() => undefined);
    }, delayMs);
    timer.unref?.();
  };
}