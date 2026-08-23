export const HEALTH_INTERVAL_MS = 30000;

/**
 * DECIDED (2026-08-23, Rook design review): a failed health probe is excused
 * when ANY completed response arrived within one probe interval — recency
 * ("at all"), not only completions newer than the failure window.
 * HttpTransport.contactAt advances only when the gateway actually answered
 * us, so recent contact is direct reachability evidence; /health failing
 * against it means contention on a single-threaded server or a lost radio
 * sample. The rejected alternative ("completions after the failure window
 * opened") produces the same detection timelines except during long
 * single-request stalls — exactly where NO completion lands after the
 * window opens and failures would accumulate toward `reconnecting` while
 * the operator's real task is still legitimately running. That false
 * positive is what this mask exists to prevent.
 */
export function hasRecentContact(lastContactAt: number, now: number): boolean {
  return lastContactAt > 0 && now - lastContactAt < HEALTH_INTERVAL_MS;
}

/**
 * A mobile radio waking up loses a request routinely. Only a run of failures
 * means the gateway is actually gone — one lost sample must not tear down a
 * working session, because every tool is gated on `status === 'connected'`.
 */
export const HEALTH_FAILURE_THRESHOLD = 2;

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;
const RECONNECT_JITTER_MIN = 0.75;
const RECONNECT_JITTER_RANGE = 0.5;

export type ConnectionMonitorCallbacks = {
  /** Resolves true when the gateway answered a health probe. */
  probe: () => Promise<boolean>;
  /** True when some other request came back recently. */
  recentlyServedUs: () => boolean;
  onStatus: (status: 'connected' | 'reconnecting', detail?: string) => void;
  /** Attempt a full reconnect. Must not throw. */
  reconnect: () => Promise<void>;
};

/**
 * Owns when a gateway is considered down and when to retry. Deliberately
 * transport-agnostic so every client shares one copy of this policy.
 */
export class ConnectionMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private attempts = 0;
  private suspended = false;
  private down = false;

  constructor(private callbacks: ConnectionMonitorCallbacks) {}

  start() {
    this.stop();
    this.failures = 0;
    this.attempts = 0;
    this.down = false;
    this.timer = setInterval(() => void this.tick(), HEALTH_INTERVAL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.clearReconnect();
    this.failures = 0;
  }

  suspend() {
    this.suspended = true;
    this.clearReconnect();
  }

  resume() {
    this.suspended = false;
  }

  get isSuspended(): boolean {
    return this.suspended;
  }

  /** Called by the client after a successful connect. */
  noteConnected() {
    this.failures = 0;
    this.attempts = 0;
    this.down = false;
    this.clearReconnect();
  }

  private async tick() {
    if (this.suspended) return;
    const healthy = await this.callbacks.probe();

    if (healthy) {
      this.failures = 0;
      if (this.down) {
        // Recovered on our own — drop the queued reconnect so it cannot
        // re-fire and bounce a healthy connection back through 'connecting'.
        this.clearReconnect();
        this.attempts = 0;
        this.down = false;
        this.callbacks.onStatus('connected');
      }
      return;
    }

    if (this.down) return;
    // A single-threaded gateway stalls /health while serving a slow request.
    // If it answered anything else recently it is busy, not gone — and that
    // answer is positive liveness evidence, so it FORGIVES the streak too:
    // a masked probe that neither counts nor forgives would let two failures
    // separated by minutes of successful traffic read as a "run" and declare
    // the gateway down after a single unevidenced probe once traffic stops.
    if (this.callbacks.recentlyServedUs()) {
      this.failures = 0;
      return;
    }

    this.failures += 1;
    if (this.failures < HEALTH_FAILURE_THRESHOLD) return;
    this.down = true;
    this.callbacks.onStatus('reconnecting', 'Gateway became unreachable');
    this.scheduleReconnect('Gateway became unreachable');
  }

  scheduleReconnect(reason: string) {
    if (this.suspended) return;
    this.attempts += 1;
    const base = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (this.attempts - 1), RECONNECT_MAX_DELAY_MS);
    // Jitter keeps a fleet of clients from retrying in lockstep after an outage.
    const delay = base * (RECONNECT_JITTER_MIN + Math.random() * RECONNECT_JITTER_RANGE);
    this.down = true;
    this.callbacks.onStatus('reconnecting', `${reason} · retry in ${Math.round(delay / 1000)}s`);
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.suspended) void this.callbacks.reconnect();
    }, delay);
  }

  private clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
