import { spawn as nodeSpawn } from 'node:child_process';

import { spawnCommand } from './adapters/shared.mjs';
import { createStdioJsonRpc } from './jsonrpc-stdio.mjs';
import { createWindowsJob } from './windows-job.mjs';

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
  onDiagnostic,
  onNotification,
  onServerRequest,
} = {}) {
  let handle = null;
  let starting = null;
  let child = null;

  return { ensureRunning, stop, isOwned: () => Boolean(child), current: () => handle };

  async function ensureRunning() {
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

    child = spawnImpl(command, [...prefix, ...descriptor.args()], {
      cwd: record.workspacePolicy?.defaultRoot,
      env,
      windowsHide: true,
    });
    job.add(child);

    const rpc = createStdioJsonRpc({
      child,
      onNotification,
      onServerRequest,
      onDiagnostic: (note) => onDiagnostic?.({ environmentId: record.id, ...note }),
    });

    // The handshake is also the liveness check: a CLI that cannot start its
    // app-server fails here rather than on the first prompt.
    if (descriptor.handshake) {
      await rpc.request(descriptor.handshake.method, descriptor.handshake.params ?? {}, { timeoutMs: 30_000 });
    }

    handle = { rpc, attached: false, transport: 'stdio' };
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
  }
}
