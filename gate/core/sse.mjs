/**
 * Shared plumbing for every SSE response the Gate writes.
 *
 * A phone is behind NAT and suspends its sockets when the screen locks, so a
 * quiet stream is indistinguishable from a dead one: an idle NAT entry can be
 * dropped at any moment and a half-open connection is invisible to the client.
 * Two things make that detectable, and they live here so no route can grow a
 * stream without them:
 *
 *   - `X-Versutus-Keepalive-Ms` tells the client how long to wait for a
 *     heartbeat before it treats the stream as dead and reconnects.
 *   - `startSseKeepalive` writes `: keepalive\n\n` on that cadence. It is an SSE
 *     comment, which every client here already ignores (the terminal client
 *     skips parts starting with ':'), so a heartbeat can never read as content.
 */

/** The cadence the protocol advertises: one keepalive every 15 s. */
export const KEEPALIVE_MS = 15000;

// How long a heartbeat may sit in the kernel buffer with no `drain` before
// the peer is treated as gone. `res.write` into a half-open socket returns
// false and does not throw, so without this a locked phone that never FINs
// keeps its shell (and the response) forever.
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

/**
 * The standard streaming headers, plus the heartbeat contract.
 *
 * `keepalive: false` is for a response that is already finished when it is
 * written — an archived run replayed from disk. It ends the moment it is
 * written, so advertising a cadence would be a promise the route cannot keep,
 * and a client told to wait 15 s for a heartbeat that was never coming.
 */
export function sseHeaders(extra = {}, { keepalive = true } = {}) {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...(keepalive ? { 'X-Versutus-Keepalive-Ms': String(KEEPALIVE_MS) } : {}),
    ...extra,
  };
}

/**
 * Follow the frame boundary of a byte-for-byte relay.
 *
 * A route that relays upstream bytes unchanged gets them at whatever boundary
 * the network split them on, so most chunks end mid-line. A keepalive written
 * between two of those chunks lands inside a half-written line, and the
 * comment's own newline terminates the partial line: the client parses the
 * truncated prefix as the event's data and drops the remainder. Pushed into
 * this, the relayed tail tells the keepalive where it is safe to write.
 *
 * The tail is read as latin1 so one byte is one character and a multi-byte
 * character split across two chunks cannot shift the answer.
 */
export function createSseFrameTracker() {
  // A stream starts on a boundary, so a heartbeat may be written before the
  // first upstream byte.
  let tail = '\n\n';
  return {
    push(chunk) {
      tail += chunk.toString('latin1');
      if (tail.length > 4) tail = tail.slice(-4);
    },
    /** True when everything written so far ends a frame (or the response is empty). */
    get atBoundary() {
      return tail.endsWith('\n\n') || tail.endsWith('\r\n\r\n');
    },
  };
}

/**
 * Write `: keepalive\n\n` on an interval until the response ends.
 *
 * Stops on the response's own `close`/`finish` and never writes to a response
 * that has already ended or been destroyed — a heartbeat into a dead socket
 * throws inside a timer, where nothing handles it. The timer is unref'd so a
 * quiet stream can never be the reason a Gate process stays alive.
 *
 * `canWrite` gates the tick, not the timer: a relay hands in its frame tracker
 * so the heartbeat waits for the boundary instead of corrupting a frame.
 *
 * @returns {() => void} `stop()`, idempotent, for a route that ends early.
 */
export function startSseKeepalive(res, { intervalMs = KEEPALIVE_MS, canWrite, drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS } = {}) {
  let timer = null;
  let drainTimer = null;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (drainTimer) clearTimeout(drainTimer);
    drainTimer = null;
    res.off('close', stop);
    res.off('finish', stop);
  };
  const waitForDrain = () => {
    if (drainTimer || stopped) return;
    drainTimer = setTimeout(() => {
      drainTimer = null;
      stop();
      try { res.destroy(); } catch { /* already gone */ }
    }, drainTimeoutMs);
    drainTimer.unref?.();
    res.once('drain', () => {
      if (drainTimer) {
        clearTimeout(drainTimer);
        drainTimer = null;
      }
    });
  };
  timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      stop();
      return;
    }
    if (canWrite && !canWrite()) return;
    if (drainTimer) return;
    try {
      const ok = res.write(': keepalive\n\n');
      if (ok === false) waitForDrain();
    } catch {
      stop();
    }
  }, intervalMs);
  timer.unref?.();
  res.on('close', stop);
  res.on('finish', stop);
  return stop;
}
