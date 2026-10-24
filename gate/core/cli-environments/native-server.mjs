import { spawn as nodeSpawn } from 'node:child_process';

import { spawnCommand } from './adapters/shared.mjs';
import { createWindowsJob } from './windows-job.mjs';

const DEFAULT_START_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 200;
/**
 * How long the health route gets to answer. A server that accepts the
 * connection and then says nothing — a wedged `opencode serve`, which
 * `isHealthy` could not tell from a refusal because it passed no signal — held
 * every `ensureRunning()` for as long as undici allowed, and neither the
 * backoff in backend-manager.mjs nor the start timeout below ever engaged,
 * because nothing threw. A health route is not a turn: it answers or it is not
 * there, and this ceiling is also what makes the re-probe inside a backoff
 * window cheap.
 */
const HEALTH_TIMEOUT_MS = 2_000;

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
  // Recovered from a spawned server's `server password <pw>` banner line when
  // no OPENCODE_SERVER_PASSWORD credential exists (OpenCode 2.x generates one
  // and prints it). Never logged: the line is redacted before note().
  let bannerPassword = null;

  /** The detected major-version profile of a contacted server, cached. */
  const serverProfiles = new Map();

  return { ensureRunning, stop, isOwned: () => owned, current: () => handle, reachable };

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

    // Spawn-on-auth-failure guard (version-aware adapters, i.e. OpenCode): a
    // candidate port that is occupied but fails the health probe (e.g. an
    // operator's OpenCode 2.x server that rejects our credentials with 401)
    // must never trigger a second `serve` — a second instance against the
    // same data directory breaks its SQLite schema. Attach with the recovered
    // banner password when we have one, else refuse with a clear error.
    if (typeof descriptor.detectMajor === 'function') {
      const occupied = await findOccupiedButUnhealthy(descriptor);
      if (occupied) {
        if (bannerPassword && (await isHealthy(occupied, descriptor))) {
          owned = false;
          handle = { baseUrl: occupied, attached: true };
          note(`attached to an existing ${adapter.adapterId} server at ${occupied} using the password from its startup banner`);
          return handle;
        }
        throw new Error(
          `${adapter.adapterId}: ${occupied} is occupied by a server that failed the health check ` +
          '(wrong or missing credentials, or not an ' + adapter.adapterId + ' server). ' +
          'Not spawning a second instance against the same data directory — fix the credentials, stop that server, or point the record elsewhere.',
        );
      }
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

  /**
   * A candidate that accepts connections but fails the health probe — the
   * "something there, not usable" state that must block a spawn. TCP refusal
   * returns null (nothing listens; spawning is safe).
   */
  async function findOccupiedButUnhealthy(descriptor) {
    for (const baseUrl of candidates(descriptor)) {
      if (await acceptsConnections(baseUrl) && !(await isHealthy(baseUrl, descriptor))) return baseUrl;
    }
    return null;
  }

  async function acceptsConnections(baseUrl) {
    try {
      const response = await fetchImpl(baseUrl, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      // Any HTTP answer at all means the port is taken; a v2 server's SPA
      // catch-all answers 200 text/html on '/', a wrong server may 404.
      void response;
      return true;
    } catch {
      return false;
    }
  }

  async function serverProfile(baseUrl, descriptor) {
    if (typeof descriptor.detectMajor !== 'function') return null;
    let profile = serverProfiles.get(baseUrl);
    if (!profile) {
      profile = Promise.resolve(
        descriptor.detectMajor({ fetchImpl, baseUrl, password: credentials?.OPENCODE_SERVER_PASSWORD }),
      ).then((major) => (major === 1 || major === 2 ? { major } : null));
      profile.catch(() => undefined);
      serverProfiles.set(baseUrl, profile);
    }
    const resolved = await profile.catch(() => null);
    if (!resolved) serverProfiles.delete(baseUrl);
    return resolved;
  }

  async function isHealthy(baseUrl, descriptor) {
    try {
      const profile = await serverProfile(baseUrl, descriptor);
      const path = profile && descriptor.healthPathFor
        ? descriptor.healthPathFor(profile.major)
        : (descriptor.healthPath ?? '/');
      const headers = profile ? authHeadersFor(profile.major, descriptor) : authHeaders();
      const response = await fetchImpl(`${baseUrl}${path}`, {
        headers,
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (!response?.ok) return false;
      if (descriptor.healthJson) {
        // A JSON body, not the ok-status, is what proves health: the v2 SPA
        // catch-all answers 200 text/html on any path, and attaching to that
        // would fail every subsequent call.
        try {
          JSON.parse(await response.text());
        } catch {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether a server this environment could use is answering right now, without
   * starting one.
   *
   * The manager asks this inside a backoff window: a refusal remembered from a
   * start that failed goes stale the moment the server is up, and re-throwing
   * the first error until the window ends reported "did not become reachable"
   * against a server that was running and reachable. Nothing is spawned here, so
   * a refusal still costs one bounded probe rather than another start timeout.
   */
  async function reachable() {
    if (!adapter?.server) return false;
    return Boolean(await findReachable(adapter.server));
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
    // Process complete lines only: a server password split across stdout
    // chunks must never reach the log, so the partial tail is held back
    // until its line completes (or the process dies with it unprinted).
    let pendingLine = '';
    const onChunk = (chunk) => {
      pendingLine += String(chunk);
      let newline;
      while ((newline = pendingLine.search(/\r?\n/)) !== -1) {
        const line = pendingLine.slice(0, newline);
        pendingLine = pendingLine.slice(newline + 1).replace(/^\r/, '');
        onLine(line);
      }
    };
    const onLine = (line) => {
      const recovered = descriptor.passwordFromOutput?.(line);
      if (recovered) bannerPassword = recovered;
      // Redact every secret the child could echo: the banner password and the
      // credential injected into its environment. A leaked line must never
      // reach the diagnostic log.
      let safe = line;
      for (const secret of [bannerPassword, credentials?.OPENCODE_SERVER_PASSWORD]) {
        if (secret) safe = safe.split(secret).join('<redacted>');
      }
      note(safe.trim());
      const found = descriptor.portFromOutput?.(safe);
      if (found && !announced) announced = `http://127.0.0.1:${found}`;
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

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
    // Detected profiles are cheap to re-resolve and keyed by URL; a spawned
    // server is gone for good, so its cached profile must not accumulate
    // across generations (ephemeral ports make a fresh key every spawn).
    serverProfiles.clear();
    // A terminate latches and keeps every pid it was given, so without this the
    // next generation's terminate would taskkill the pids of the last one —
    // dead pids, which Windows recycles.
    job.reset?.();
  }

  function authHeaders() {
    const password = credentials?.OPENCODE_SERVER_PASSWORD;
    return password ? { Authorization: `Bearer ${password}` } : {};
  }

  /**
   * Auth for a server whose major version has been detected: OpenCode 2.x is
   * always-on HTTP Basic `opencode:<password>`, v1 opt-in Bearer. The banner
   * password recovered from our own spawn stands in when no credential is
   * bound (it is never logged — see the redaction above).
   */
  function authHeadersFor(major, descriptor) {
    const password = credentials?.OPENCODE_SERVER_PASSWORD ?? bannerPassword;
    if (!password) return {};
    if (descriptor.authSchemeFor?.(major) === 'basic') {
      return { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
    }
    return { Authorization: `Bearer ${password}` };
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
