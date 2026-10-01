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

/**
 * Consecutive failed retries one dialect may burn on a single dead address
 * before it stops and hands recovery back to the app's auto-connect loop,
 * which re-probes candidates instead of hammering the same URL forever.
 */
export const RECONNECT_ESCALATION_ATTEMPTS = 5;

/**
 * Two quick samples are the same evidence as two 30s samples, and the caller
 * paying for the nudge is holding evidence of its own (a stalled stream, a
 * refused write) — so re-prove a nudge failure this soon instead of waiting out
 * the interval.
 */
export const NUDGE_REPROBE_DELAY_MS = 2000;

/**
 * One bad moment must not become a probe storm. Long enough that a flapping
 * radio gets one verdict per window, short enough that a second, separate
 * complaint still gets answered.
 */
export const NUDGE_COOLDOWN_MS = 5000;

export type ConnectionMonitorCallbacks = {
  /**
   * Resolves true when the gateway answered a health probe. Omit for a
   * scheduler-only monitor: a dialect with no verified health wire (the
   * OpenClaw WebSocket) never starts the interval and only owns retry
   * scheduling.
   */
  probe?: () => Promise<boolean>;
  /** True when some other request came back recently. */
  recentlyServedUs?: () => boolean;
  /**
   * Fired the moment the failure streak declares the path down, before the
   * reconnect ladder takes over. A dialect that publishes its own health
   * samples uses it to report the loss on the same channel as its successes.
   */
  onDeclaredDown?: (reason: string) => void;
  onStatus: (
    status: 'connected' | 'reconnecting' | 'disconnected',
    detail?: string,
  ) => void;
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
  private nudgeReprobeTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private attempts = 0;
  private suspended = false;
  private down = false;
  private probing = false;
  private lastNudgeAt = 0;

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
    this.clearNudgeReprobe();
    this.lastNudgeAt = 0;
    this.failures = 0;
    this.attempts = 0;
    this.down = false;
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
    this.clearNudgeReprobe();
  }

  /**
   * Probe NOW rather than waiting for the next interval tick.
   *
   * A dead path is otherwise only visible after two failed 30s samples —
   * 42–72s of a chat that is already dead. A caller holding its own evidence
   * of trouble (a stalled stream, a refused write) hands that evidence here
   * and gets a verdict in seconds. A successful nudge changes nothing; a
   * failed one counts as a sample and is re-proved 2s later, so two quick
   * failures reach the same threshold the interval would have.
   *
   * Guarded three ways on purpose: a suspended monitor owes no verdict, a
   * probe already in flight is the verdict, and the cooldown keeps one bad
   * moment from becoming a probe storm. A monitor that was never started is
   * left alone — a nudge must not open an interval on a client nobody
   * connected.
   */
  nudge(_reason: string) {
    if (this.suspended || !this.callbacks.probe || !this.timer) return;
    if (this.probing) return;
    const now = Date.now();
    if (this.lastNudgeAt > 0 && now - this.lastNudgeAt < NUDGE_COOLDOWN_MS) return;
    this.lastNudgeAt = now;
    void this.probeNow();
  }

  private async probeNow() {
    const healthy = await this.runProbe();
    if (healthy === null) return;
    const down = this.recordProbe(healthy);
    // Nothing to re-prove: the path answered, or this failure already declared
    // it down and the reconnect ladder owns recovery from here.
    if (healthy || down) return;
    // Re-prove a lone failure: one lost sample is not a dead path, and waiting
    // 30s for the interval to agree is the delay this call exists to remove.
    this.clearNudgeReprobe();
    this.nudgeReprobeTimer = setTimeout(() => {
      this.nudgeReprobeTimer = null;
      if (this.suspended || !this.timer) return;
      void this.probeNow();
    }, NUDGE_REPROBE_DELAY_MS);
  }

  /**
   * One probe, or null when another probe is already in flight — two
   * concurrent verdicts would fold into the same failure streak twice.
   */
  private async runProbe(): Promise<boolean | null> {
    if (this.probing || !this.callbacks.probe) return null;
    this.probing = true;
    try {
      return await this.callbacks.probe();
    } finally {
      this.probing = false;
    }
  }

  private async tick() {
    if (this.suspended || !this.callbacks.probe) return;
    const healthy = await this.runProbe();
    if (healthy === null) return;
    this.recordProbe(healthy);
  }

  /** Fold one verdict into the failure streak. True once the path is declared down. */
  private recordProbe(healthy: boolean): boolean {
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
      return false;
    }

    if (this.down) return true;
    // A single-threaded gateway stalls /health while serving a slow request.
    // If it answered anything else recently it is busy, not gone — and that
    // answer is positive liveness evidence, so it FORGIVES the streak too:
    // a masked probe that neither counts nor forgives would let two failures
    // separated by minutes of successful traffic read as a "run" and declare
    // the gateway down after a single unevidenced probe once traffic stops.
    if (this.callbacks.recentlyServedUs?.()) {
      this.failures = 0;
      return false;
    }

    this.failures += 1;
    if (this.failures < HEALTH_FAILURE_THRESHOLD) return false;
    this.down = true;
    this.callbacks.onDeclaredDown?.('Gateway became unreachable');
    this.callbacks.onStatus('reconnecting', 'Gateway became unreachable');
    this.scheduleReconnect('Gateway became unreachable');
    return true;
  }

  scheduleReconnect(reason: string) {
    if (this.suspended) return;
    if (this.attempts >= RECONNECT_ESCALATION_ATTEMPTS) {
      // Sustained failure: stop re-opening the same connection on our own and
      // report an honest 'disconnected'. The provider's phase table maps that
      // status onto its scheduled auto-retry, which re-probes candidates
      // instead of this ladder hammering one URL forever. The ladder resets,
      // so whatever fires next starts politely; `down` stays set so the probe
      // interval cannot start a rival wave, and a gateway that returns is
      // still caught by the next successful probe's self-heal.
      this.attempts = 0;
      this.clearReconnect();
      this.down = true;
      this.callbacks.onStatus(
        'disconnected',
        `${reason} · paused after ${RECONNECT_ESCALATION_ATTEMPTS} failed retries`,
      );
      return;
    }
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

  private clearNudgeReprobe() {
    if (this.nudgeReprobeTimer) clearTimeout(this.nudgeReprobeTimer);
    this.nudgeReprobeTimer = null;
  }
}
