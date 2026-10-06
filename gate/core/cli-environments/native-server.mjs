import { spawn as nodeSpawn } from 'node:child_process';

import { spawnCommand } from './adapters/shared.mjs';
import { createWindowsJob } from './windows-job.mjs';

const DEFAULT_START_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 200;

/**
 * Supervise the native server an agent CLI exposes — the thing that owns that
 * platform's sessions, models and tools.
 *
 * Attach before spawn, always. A developer commonly leaves `opencode serve`
 * running, and a second instance against the same SQLite data directory breaks
 * schema migrations (observed: prompts failing with `no such column:
 * replacement_seq` until every instance was stopped). A server we attached to is
 * never ours to kill, so `stop()` only terminates a child we started.
 */
export function createNativeServer({
  record,
  adapter,
  job = createWindowsJob(),
  vault,
  credentials = {},
  buildEnvironment,
  spawnImpl = nodeSpawn,
  fetchImpl = fetch,
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  onDiagnostic,
} = {}) {
  let handle = null;
  let starting = null;
  let owned = false;
  let child = null;

  return { ensureRunning, stop, isOwned: () => owned, current: () => handle };

  async function ensureRunning() {
    const descriptor = adapter?.server;
    if (!descriptor) {
      throw new Error(`Adapter "${adapter?.adapterId ?? 'unknown'}" does not expose a native server.`);
    }
    // A cached handle is a moment in time, not a lease: an attached server
    // the operator stops, or a spawned child that dies, answers nothing from
    // here on, and every later turn failed with a bare transport error while
    // the environment still reported ready (that state probes the CLI binary,
    // not this server). Revalidate before trusting it; a dead handle is
    // dropped so start() below re-attaches or spawns fresh.
    if (handle && !(await isHealthy(handle.baseUrl, descriptor))) {
      await stop();
    }
    if (handle) return handle;
    // Concurrent callers share one attempt; two spawns is the failure mode.
    if (starting) return starting;
    starting = start().finally(() => { starting = null; });
    return starting;
  }

  async function start() {
    const descriptor = adapter?.server;
    if (!descriptor) {
      throw new Error(`Adapter "${adapter?.adapterId ?? 'unknown'}" does not expose a native server.`);
    }

    const attachedUrl = await findReachable(descriptor);
    if (attachedUrl) {
      owned = false;
      handle = { baseUrl: attachedUrl, attached: true };
      note(`attached to an existing ${adapter.adapterId} server at ${attachedUrl}`);
      return handle;
    }

    const baseUrl = await spawnServer(descriptor);
    owned = true;
    handle = { baseUrl, attached: false };
    note(`started ${adapter.adapterId} at ${baseUrl}`);
    return handle;
  }

  /** Candidate origins, most specific first. */
  function candidates(descriptor) {
    const urls = [];
    if (record?.server?.baseUrl) urls.push(String(record.server.baseUrl).replace(/\/+$/, ''));
    if (descriptor.defaultPort) urls.push(`http://127.0.0.1:${descriptor.defaultPort}`);
    return [...new Set(urls)];
  }

  async function findReachable(descriptor) {
    for (const baseUrl of candidates(descriptor)) {
      if (await isHealthy(baseUrl, descriptor)) return baseUrl;
    }
    return null;
  }

  async function isHealthy(baseUrl, descriptor) {
    try {
      const response = await fetchImpl(`${baseUrl}${descriptor.healthPath ?? '/'}`, {
        headers: authHeaders(),
      });
      return Boolean(response?.ok);
    } catch {
      return false;
    }
  }

  async function spawnServer(descriptor) {
    // A fixed-port server (Hermes) listens where the record says, else on its
    // default; an ephemeral one is handed 0 and announces its port on stdout.
    const port = descriptor.ephemeralPort === false
      ? (portOf(record?.server?.baseUrl) ?? descriptor.defaultPort)
      : 0;
    const { command, prefix } = spawnCommand(record.executable.path);
    const args = [...prefix, ...descriptor.args(port)];
    const baseEnv = buildEnvironment
      ? await buildEnvironment({ record, credentials })
      : { ...process.env, ...credentials };
    // A server configured through its environment (Hermes' API_SERVER_*)
    // declares those variables itself; they are layered last so a stray
    // inherited value cannot point the server somewhere the Gate is not polling.
    const env = { ...baseEnv, ...(descriptor.env?.({ port, credentials, record }) ?? {}) };

    child = spawnImpl(command, args, {
      cwd: record.workspacePolicy?.defaultRoot,
      env,
      windowsHide: true,
    });
    job.add(child);

    let announced = null;
    const onLine = (chunk) => {
      const text = String(chunk);
      note(text.trim());
      const found = descriptor.portFromOutput?.(text);
      if (found && !announced) announced = `http://127.0.0.1:${found}`;
    };
    child.stdout?.on('data', onLine);
    child.stderr?.on('data', onLine);

    let exited = null;
    child.on('exit', (code) => { exited = code; });

    // A missing executable reports 'error' and never 'exit', so without this
    // listener Node turns it into an uncaught exception that takes the Gate and
    // every stream on it down — instead of the named refusal below. `wake` cuts
    // the poll short so the refusal is immediate rather than one interval late.
    let spawnError = null;
    let wake;
    const spawnFailed = new Promise((resolve) => { wake = resolve; });
    child.on('error', (error) => {
      spawnError = new Error(
        `${adapter.adapterId} server could not start ${command}: ${error?.code ?? error?.message ?? error}`,
      );
      wake();
    });

    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      if (spawnError) {
        await stop();
        throw spawnError;
      }
      if (exited !== null) {
        throw new Error(`${adapter.adapterId} server exited with code ${exited} before becoming reachable.`);
      }
      const fallbackPort = port || descriptor.defaultPort;
      const target = announced ?? (fallbackPort ? `http://127.0.0.1:${fallbackPort}` : null);
      if (target && (await isHealthy(target, descriptor))) return target;
      await Promise.race([delay(POLL_INTERVAL_MS), spawnFailed]);
    }
    await stop();
    throw new Error(`${adapter.adapterId} server did not become reachable within ${startTimeoutMs}ms.`);
  }

  /** A server we attached to belongs to the operator; leave it running. */
  async function stop() {
    if (owned && child) {
      try {
        child.kill();
      } catch {
        // already gone
      }
      await job.terminate().catch(() => undefined);
    }
    child = null;
    handle = null;
    owned = false;
    // A terminate latches and keeps every pid it was given, so without this the
    // next generation's terminate would taskkill the pids of the last one —
    // dead pids, which Windows recycles.
    job.reset?.();
  }

  function authHeaders() {
    const password = credentials?.OPENCODE_SERVER_PASSWORD;
    return password ? { Authorization: `Bearer ${password}` } : {};
  }

  function note(message) {
    onDiagnostic?.({ environmentId: record?.id, message });
  }
}

/** The explicit port of a configured base URL, or null. */
function portOf(baseUrl) {
  if (!baseUrl) return null;
  try {
    const port = Number(new URL(String(baseUrl)).port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
