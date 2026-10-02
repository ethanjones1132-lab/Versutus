// ─── One warm voice worker for every call on this Gate ─────────────────────
// The Python worker takes tens of seconds to load Whisper, Silero, Kokoro and
// Smart Turn, and it said nothing while it did: `createEngine` built a new
// LocalEngine per call, `open()` returned as soon as the process was SPAWNED,
// and `close()` killed it, so nothing was ever warm. Measured on a live call
// (2026-10-02) the first transcript arrived 17.9 s after the media stream
// opened. The worker announces `voice.ready` once its models exist; this pool
// owns the process, answers "is there a worker?" with that one signal, and
// hands calls a lease on it.
//
// The Gate allows one call at a time (`voice.capabilities` advertises
// `maxConcurrentCalls: 1`), so the pool owns at most one lease: a second
// concurrent one fails fast with a named error rather than sharing a pipeline
// whose state (`_reset` on every `voice.open`) belongs to one call.
//
// Everything is injectable — the process, the JSON-RPC transport, the clock and
// both timers — so the tests drive a worker that never loads anything.

import { createStdioJsonRpc } from '../../cli-environments/jsonrpc-stdio.mjs';

/** How long a worker may take to load its models before it is written off. */
export const READY_TIMEOUT_MS = 180_000;
/** How long a released worker stays warm before it gives the GPU back. */
export const IDLE_TIMEOUT_MS = 30 * 60_000;
/** How often a dead worker is respawned, then the call is given up on. */
export const RESTART_BACKOFF_MS = [250, 500, 1000, 2000];
export const MAX_RESTARTS = 5;
/** How long `voice.close` may take to be answered before it is abandoned. */
const CLOSE_TIMEOUT_MS = 5_000;

function namedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createVoiceWorkerPool({
  spawn,
  createRpc = createStdioJsonRpc,
  now = () => Date.now(),
  schedule = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  cancel = (timer) => clearTimeout(timer),
  idleMs = IDLE_TIMEOUT_MS,
  readyTimeoutMs = READY_TIMEOUT_MS,
  backoffMs = RESTART_BACKOFF_MS,
  maxRestarts = MAX_RESTARTS,
  log = () => {},
  onDiagnostic = () => {},
} = {}) {
  let child = null;
  let rpc = null;
  /** The `voice.ready` params of the live worker; its presence is "warm". */
  let ready = null;
  /** Callers waiting for that signal. */
  let waiting = [];
  let readyTimer = null;
  let idleTimer = null;
  let restartTimer = null;
  let held = null;
  let restarts = 0;
  /** Why the last warm cycle was given up on, so every waiter says the same. */
  let givenUp = null;
  let stopped = false;

  const diagnose = (line) => {
    log(line);
    onDiagnostic(line);
  };

  function clearReadyTimer() {
    if (!readyTimer) return;
    cancel(readyTimer);
    readyTimer = null;
  }

  function clearIdleTimer() {
    if (!idleTimer) return;
    cancel(idleTimer);
    idleTimer = null;
  }

  function clearRestartTimer() {
    if (!restartTimer) return;
    cancel(restartTimer);
    restartTimer = null;
  }

  function killWorker(reason) {
    const dying = child;
    const dyingRpc = rpc;
    child = null;
    rpc = null;
    ready = null;
    clearReadyTimer();
    clearIdleTimer();
    clearRestartTimer();
    try {
      dyingRpc?.close();
    } catch {
      // the worker is already gone
    }
    try {
      dying?.kill?.();
    } catch {
      // the worker is already gone
    }
    if (dying) diagnose(`voice.worker stopped reason=${reason}`);
  }

  function start() {
    if (stopped || child) return;
    clearReadyTimer();
    clearIdleTimer();
    clearRestartTimer();
    const born = spawn();
    child = born;
    rpc = createRpc({
      child: born,
      onNotification,
      onDiagnostic: (event) => diagnose(event?.message ?? String(event)),
    });
    born.on('exit', (code) => onDeath(code, born));
    // A worker that cannot be spawned (no python) reports 'error' and then
    // 'close', never 'exit' — with no listener that uncaught exception takes the
    // whole Gate down instead of restarting this one call. The identity check
    // in onDeath counts the two events as one death, so the restart budget is
    // spent once per worker.
    born.on('error', (error) => {
      diagnose(`voice worker failed: ${error.message}`);
      onDeath(null, born);
    });
    readyTimer = schedule(onReadyTimeout, readyTimeoutMs);
  }

  function onReadyTimeout() {
    readyTimer = null;
    if (!child) return;
    killWorker('ready-timeout');
    failCycle(
      namedError('worker_not_ready', `The voice worker did not load its models within ${readyTimeoutMs}ms.`),
    );
  }

  function onDeath(code, who) {
    if (child !== who) return;
    child = null;
    rpc = null;
    ready = null;
    clearReadyTimer();
    if (stopped) return;
    if (restartTimer) return;
    // A worker nobody is using does not come back on its own: the next lease
    // pays for the model load again rather than keeping the GPU warm for a call
    // that may not arrive.
    if (!held && waiting.length === 0) {
      log(`voice.worker died code=${code} while idle`);
      return;
    }
    if (restarts >= maxRestarts) {
      givenUp = namedError('worker_failed', `The voice worker exited ${restarts + 1} times without staying up.`);
      log(`voice.worker failed restarts=${restarts} lastCode=${code}`);
      failCycle(givenUp);
      return;
    }
    const delay = backoffMs[Math.min(restarts, backoffMs.length - 1)];
    restarts += 1;
    log(`voice.worker died code=${code} restart=${restarts} inMs=${delay}`);
    restartTimer = schedule(() => {
      restartTimer = null;
      if (stopped) return;
      if (held || waiting.length) start();
    }, delay);
  }

  /**
   * End the current cycle honestly: every waiter is told, and a call that is
   * already holding this worker is told too, so it ends with a reason instead
   * of sitting deaf for the rest of its life.
   */
  function failCycle(error) {
    givenUp = error;
    const dead = held;
    held = null;
    if (dead) {
      for (const handler of dead.handlers) {
        try {
          handler({
            method: 'voice.error',
            params: { code: 'engine_failed', message: error.message, fatal: true, gen: null },
          });
        } catch {
          // one bad listener must not keep the call from ending
        }
      }
      dead.handlers.clear();
    }
    const waiters = waiting;
    waiting = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  function onNotification(message) {
    const method = message?.method;
    if (method === 'voice.ready') {
      const params = message.params ?? {};
      ready = params;
      // The budget is spent by deaths that never reached a working worker; one
      // that did has proved the worker can run, so the next bad night starts
      // from a full budget again.
      restarts = 0;
      givenUp = null;
      clearReadyTimer();
      log(`voice.worker ready loadMs=${params.loadMs} device=${params.device}`);
      const waiters = waiting;
      waiting = [];
      for (const waiter of waiters) waiter.resolve(params);
    }
    if (!held) return;
    for (const handler of held.handlers) {
      try {
        handler(message);
      } catch {
        // one bad listener must not deaf the call
      }
    }
  }

  function armIdleTimer() {
    clearIdleTimer();
    if (!(idleMs > 0) || stopped || held) return;
    idleTimer = schedule(() => {
      idleTimer = null;
      if (held || stopped) return;
      log(`voice.worker idle afterMs=${idleMs}`);
      killWorker('idle');
    }, idleMs);
  }

  function channel() {
    if (stopped) throw namedError('worker_pool_shutdown', 'The voice worker pool has been shut down.');
    // A lease spans a restart: the worker it holds is gone until a new one says
    // `voice.ready`, and writing into that gap is how a reply was lost.
    if (!rpc || !ready) throw namedError('worker_not_ready', 'The voice worker is not running.');
    return rpc;
  }

  /**
   * Spawn the worker if it is not already up, and resolve when it says
   * `voice.ready`. Idempotent: a warm worker resolves at once, so the warm
   * start and a call's lease are the same request.
   */
  async function warm() {
    if (stopped) throw namedError('worker_pool_shutdown', 'The voice worker pool has been shut down.');
    if (ready) return ready;
    // Nothing of this cycle is left to fail, so this is a fresh attempt with a
    // full restart budget — a worker written off at 3am must not keep the first
    // call of the morning from trying again.
    if (!child && !restartTimer) {
      restarts = 0;
      givenUp = null;
    }
    start();
    return new Promise((resolve, reject) => {
      waiting.push({ resolve, reject });
    });
  }

  /**
   * The call's handle on the worker. `send` is fire-and-forget (`speak`,
   * audio), `request` waits for the worker's answer (`voice.open`), and
   * `onNotification` receives everything the worker emits while the lease is
   * held — including a second `voice.ready` after a restart.
   */
  async function lease() {
    if (stopped) throw namedError('worker_pool_shutdown', 'The voice worker pool has been shut down.');
    if (held) {
      throw namedError('worker_busy', 'Another voice call is already using the PC voice worker.');
    }
    await warm();
    if (held) {
      throw namedError('worker_busy', 'Another voice call is already using the PC voice worker.');
    }
    clearIdleTimer();
    const handlers = new Set();
    const mine = {
      handlers,
      send(method, params) {
        channel().notify(method, params);
      },
      request(method, params, options) {
        return channel().request(method, params, options);
      },
      onNotification(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      release: () => release(mine),
    };
    held = mine;
    return mine;
  }

  /** End the call's work, keep the process: the next call reuses the models. */
  function release(mine) {
    if (held !== mine) return;
    held = null;
    mine.handlers.clear();
    const live = rpc;
    if (live && ready) {
      try {
        // Asked for, not required: a worker that never answers `voice.close`
        // still goes idle on this Gate's timer.
        Promise.resolve(live.request('voice.close', {}, { timeoutMs: CLOSE_TIMEOUT_MS })).catch(() => {});
      } catch {
        // the worker is already gone
      }
    }
    armIdleTimer();
  }

  /** The Gate is closing: no lease survives it, and no worker does either. */
  async function shutdown() {
    stopped = true;
    held = null;
    killWorker('gate-close');
    const waiters = waiting;
    waiting = [];
    const error = namedError('worker_pool_shutdown', 'The voice worker pool has been shut down.');
    for (const waiter of waiters) waiter.reject(error);
  }

  return { warm, lease, release, shutdown, get ready() { return ready; }, get leased() { return Boolean(held); } };
}
