/**
 * The Gate supervisor: keeps one `gate start` child alive across crashes,
 * kills it when it stops answering the manifest, and records every
 * transition for `service status`.
 *
 * Pure logic — the process spawn, the health probe, the tree kill, the clock
 * and the timers are all injected, so the restart/backoff/health rules are
 * tested with fake children and recorded delays, never real processes.
 *
 * The child is spawned with an IPC channel (`stdio … 'ipc'`): restart and
 * stop first ask it to close gracefully (`{type:'shutdown'}`) and only
 * tree-kill after `stopKillMs`, so in-flight phone calls get a clean close.
 */
export const RESTART_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000, 60000];
/** Exit 75 means someone else holds the port or the lock: wait, don't spin. */
export const CONFLICT_WAIT_MS = 60000;

export class Supervisor {
  constructor({
    spawnGate,
    probe,
    killTree,
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancel = (id) => clearTimeout(id),
    now = () => Date.now(),
    writeState = () => {},
    log = () => {},
    backoffMs = RESTART_BACKOFF_MS,
    graceMs = 90000,
    probeIntervalMs = 30000,
    stableMs = 10 * 60 * 1000,
    stopKillMs = 10000,
    codeRoot = null,
    gitHead = null,
  } = {}) {
    if (typeof spawnGate !== 'function') throw new Error('spawnGate is required');
    if (typeof probe !== 'function') throw new Error('probe is required');
    if (typeof killTree !== 'function') throw new Error('killTree is required');
    this._spawnGate = spawnGate;
    this._probe = probe;
    this._killTree = killTree;
    this._schedule = schedule;
    this._cancel = cancel;
    this._now = now;
    this._writeState = writeState;
    this._log = log;
    this._backoffMs = backoffMs;
    this._graceMs = graceMs;
    this._probeIntervalMs = probeIntervalMs;
    this._stableMs = stableMs;
    this._stopKillMs = stopKillMs;
    this._codeRoot = codeRoot;
    this._gitHead = gitHead;

    this._status = 'starting';
    this._child = null;
    this._childPid = null;
    this._childStartedAt = null;
    this._restarts = 0;
    this._failures = 0;
    this._lastExit = null;
    this._lastHealthyAt = null;
    this._stopping = false;
    this._timers = new Set();
  }

  /** Start supervising: spawn the first child now. */
  start() {
    this._spawn();
  }

  /** Graceful stop: ask the child to close, tree-kill after the cap, never respawn. */
  async stop() {
    this._stopping = true;
    this._status = 'stopping';
    this._clearTimers();
    this._emitState();
    if (!this._child) {
      this._status = 'stopped';
      this._emitState();
      return;
    }
    this._askGracefulStop();
    const child = this._child;
    await this._sleep(this._stopKillMs);
    if (this._child === child && this._child) this._forceKill('stop timed out');
  }

  /** Graceful restart: same as stop, but the exit handler respawns. */
  requestRestart() {
    if (this._stopping) return;
    this._log('restart requested');
    if (!this._child) {
      this._spawn();
      return;
    }
    this._status = 'restarting';
    this._emitState();
    this._askGracefulStop();
    const child = this._child;
    this._later(this._stopKillMs, () => {
      if (this._child === child && this._child) this._forceKill('restart timed out');
    });
  }

  _spawn() {
    if (this._stopping) return;
    this._clearTimers();
    this._status = this._restarts === 0 && this._failures === 0 ? 'starting' : 'restarting';
    const child = this._spawnGate();
    this._child = child;
    this._childPid = child?.pid ?? null;
    this._childStartedAt = this._now();
    this._status = 'running';
    this._emitState();
    child?.once?.('exit', (code, signal) => this._onExit(code, signal));
    // A probe that fires during startup proves nothing: give the Gate its
    // grace period before the first check, then probe on a fixed interval.
    this._later(this._graceMs, () => this._probeLoop(0));
  }

  async _probeLoop(fails) {
    if (this._stopping || !this._child) return;
    let healthy = false;
    try {
      healthy = Boolean(await this._probe());
    } catch (error) {
      this._log(`health probe failed: ${error?.message ?? error}`);
    }
    if (this._stopping || !this._child) return;
    if (healthy) {
      this._lastHealthyAt = this._now();
      this._emitState();
      this._later(this._probeIntervalMs, () => this._probeLoop(0));
      return;
    }
    const next = fails + 1;
    this._log(`health probe failed ${next} in a row`);
    if (next >= 4) {
      this._log('gate unhealthy: killing the child');
      this._forceKill('unhealthy');
      return;
    }
    this._later(this._probeIntervalMs, () => this._probeLoop(next));
  }

  _onExit(code, signal) {
    const at = new Date(this._now()).toISOString();
    this._child = null;
    this._childPid = null;
    this._clearTimers();
    this._lastExit = { code: code ?? null, signal: signal ?? null, at };
    if (this._stopping) {
      this._status = 'stopped';
      this._log(`child exited (${describeExit(code, signal)}); staying stopped`);
      this._emitState();
      return;
    }
    this._restarts += 1;
    // Ten quiet minutes forgive the past: the next failure starts over at 1 s.
    if (this._childStartedAt !== null && this._now() - this._childStartedAt >= this._stableMs) {
      this._failures = 0;
    }
    this._failures += 1;
    const conflict = code === 75;
    const delay = conflict
      ? CONFLICT_WAIT_MS
      : this._backoffMs[Math.min(this._failures - 1, this._backoffMs.length - 1)];
    this._status = 'restarting';
    this._log(`child exited (${describeExit(code, signal)}); restarting in ${delay} ms (restart ${this._restarts})`);
    this._emitState();
    this._later(delay, () => this._spawn());
  }

  _askGracefulStop() {
    try {
      this._child?.send?.({ type: 'shutdown' });
    } catch (error) {
      this._log(`graceful shutdown send failed: ${error?.message ?? error}`);
    }
  }

  _forceKill(reason) {
    const pid = this._childPid;
    if (pid === null || pid === undefined) return;
    this._log(`tree-killing pid ${pid}: ${reason}`);
    try {
      this._killTree(pid);
    } catch (error) {
      this._log(`tree-kill failed: ${error?.message ?? error}`);
    }
  }

  _later(ms, fn) {
    const id = this._schedule(() => {
      this._timers.delete(id);
      fn();
    }, ms);
    this._timers.add(id);
    return id;
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const id = this._schedule(() => {
        this._timers.delete(id);
        resolve();
      }, ms);
      this._timers.add(id);
    });
  }

  _clearTimers() {
    for (const id of this._timers) {
      try {
        this._cancel(id);
      } catch {
        // A spent timer is already gone — nothing to cancel.
      }
    }
    this._timers.clear();
  }

  _emitState() {
    this._writeState({
      status: this._status,
      supervisorPid: process.pid,
      childPid: this._childPid,
      childStartedAt: this._childStartedAt === null
        ? null
        : new Date(this._childStartedAt).toISOString(),
      restarts: this._restarts,
      lastExit: this._lastExit,
      lastHealthyAt: this._lastHealthyAt === null
        ? null
        : new Date(this._lastHealthyAt).toISOString(),
      codeRoot: this._codeRoot,
      gitHead: this._gitHead,
    });
  }
}

function describeExit(code, signal) {
  if (code !== null && code !== undefined) return `code ${code}`;
  return `signal ${signal ?? 'unknown'}`;
}
