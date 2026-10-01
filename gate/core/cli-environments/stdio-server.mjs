import { spawn as nodeSpawn } from 'node:child_process';

import { spawnCommand } from './adapters/shared.mjs';
import { createStdioJsonRpc } from './jsonrpc-stdio.mjs';
import { createWindowsJob } from './windows-job.mjs';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * Supervise a CLI whose native server speaks JSON-RPC over stdio rather than
 * HTTP (Codex's `app-server`).
 *
 * There is nothing to attach to here — a stdio server is bound to the pipe of
 * the process that spawned it — so unlike the HTTP case this always owns its
 * child and always terminates it on stop.
 */
export function createStdioServer({
  record,
  adapter,
  job = createWindowsJob(),
  credentials = {},
  buildEnvironment,
  spawnImpl = nodeSpawn,
  handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  onDiagnostic,
  onNotification,
  onServerRequest,
} = {}) {
  let handle = null;
  let starting = null;
  let child = null;
  // Bumped on every exit so a respawn is distinguishable from the process that
  // died; the manager keys its cached backend on it.
  let generation = 0;

  return { ensureRunning, stop, isOwned: () => Boolean(child), current: () => handle };

  async function ensureRunning() {
    // A dead child's handle is dropped by its own 'exit' listener below, so
    // reaching here with a handle means the pipe is still live.
    if (handle) return handle;
    if (starting) return starting;
    starting = start().finally(() => { starting = null; });
    return starting;
  }

  async function start() {
    const descriptor = adapter?.server;
    if (!descriptor) {
      throw new Error(`Adapter "${adapter?.adapterId ?? 'unknown'}" does not expose a native server.`);
    }

    const { command, prefix } = spawnCommand(record.executable.path);
    const env = buildEnvironment
      ? await buildEnvironment({ record, credentials })
      : { ...process.env, ...credentials };

    const spawned = spawnImpl(command, [...prefix, ...descriptor.args()], {
      cwd: record.workspacePolicy?.defaultRoot,
      env,
      windowsHide: true,
    });
    child = spawned;
    job.add(spawned);

    // A missing executable reports 'error' and never 'exit', so without this
    // listener Node turns it into an uncaught exception that takes the Gate and
    // every stream on it down. The rpc below adds its own listener; this one is
    // what makes the failure a refusal of start() instead of a 30s handshake wait.
    let spawnFailure = null;
    let noteSpawnFailure;
    const failed = new Promise((_, reject) => { noteSpawnFailure = reject; });
    spawned.on('error', (error) => {
      spawnFailure = new Error(
        `${adapter?.adapterId ?? 'The CLI'} app-server could not start ${command}: ${error?.code ?? error?.message ?? error}`,
      );
      noteSpawnFailure(spawnFailure);
    });

    // The pipe is gone: the cached handle is dead and every later request would
    // fail on it ("app-server is not running") until the Gate restarted.
    spawned.on('exit', () => {
      if (child !== spawned) return;
      child = null;
      handle = null;
      generation += 1;
    });

    const rpc = createStdioJsonRpc({
      child: spawned,
      onNotification,
      onServerRequest,
      onDiagnostic: (note) => onDiagnostic?.({ environmentId: record.id, ...note }),
    });

    // The handshake is also the liveness check: a CLI that cannot start its
    // app-server fails here rather than on the first prompt.
    const ready = descriptor.handshake
      ? rpc.request(descriptor.handshake.method, descriptor.handshake.params ?? {}, { timeoutMs: handshakeTimeoutMs })
      // Nothing to handshake against: give the spawn one turn to report itself,
      // which is when Node delivers 'error'.
      : new Promise((resolve) => { setImmediate(resolve); });
    try {
      await Promise.race([ready, failed]);
    } catch (error) {
      // A handshake that fails or times out leaves behind a child nothing can
      // reach: `handle` was never assigned, so the next ensureRunning() spawns
      // another one — and the manager's backoff makes it spawn sooner, not later,
      // until the host is carrying a dozen silent app-servers. Reap this one
      // before the refusal leaves; the retry then starts from nothing.
      await stop();
      // A missing executable is reported twice — by the listener above and by
      // the rpc's own — and the first is the one that names the executable.
      throw spawnFailure ?? error;
    }

    handle = { rpc, attached: false, transport: 'stdio', generation };
    return handle;
  }

  async function stop() {
    if (child) {
      try {
        child.kill();
      } catch {
        // already gone
      }
      await job.terminate().catch(() => undefined);
    }
    child = null;
    handle = null;
    // A terminate latches and keeps every pid it was given, so without this the
    // next generation's terminate would taskkill the pids of the last one —
    // dead pids, which Windows recycles.
    job.reset?.();
  }
}
