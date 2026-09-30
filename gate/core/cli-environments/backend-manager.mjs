import { createNativeServer } from './native-server.mjs';
import { createStdioServer } from './stdio-server.mjs';

// How long a backend whose server will not start stays unretried. The first
// cold read after a Gate restart otherwise pays the supervisor's whole start
// timeout again on every follow-up request, for a server that is simply absent.
const BACKOFF_STEPS_MS = [5_000, 15_000, 60_000, 300_000];

/**
 * Resolves an environment id to a live backend — the native server that owns
 * that platform's sessions, models and tools.
 *
 * One supervisor per environment, cached: a second native server against the
 * same data directory corrupts it, so this is the single place allowed to bring
 * one up.
 */
export function createBackendManager({
  store,
  registry,
  vault,
  // Live per-environment status, shared with CliEnvironmentService. Adapter
  // capabilities are a static declaration; this is what says whether the CLI
  // behind them answered.
  environmentState,
  buildEnvironment,
  onDiagnostic,
  // Left undefined so the transport picks the supervisor; an injected factory
  // (tests) overrides both.
  createServer,
  // Injectable so a suite can walk the backoff windows without waiting them out.
  now = Date.now,
} = {}) {
  const servers = new Map();
  const backends = new Map();
  // A stdio server multiplexes every thread over one connection, so listeners
  // register here and filter by their own session.
  const listeners = new Map();
  const methodSets = new Map();
  // Environments whose server failed to start, with the window before the next
  // attempt. Cleared by the first success.
  const unavailable = new Map();

  return { get, list, describe, methodsOf, stopAll, isBackendCapable, subscribe };

  /** Receive raw notifications for an environment; returns an unsubscribe. */
  function subscribe(environmentId, handler) {
    const set = listeners.get(environmentId) ?? new Set();
    set.add(handler);
    listeners.set(environmentId, set);
    return () => set.delete(handler);
  }

  function fanOut(environmentId, message) {
    for (const handler of listeners.get(environmentId) ?? []) {
      try {
        handler(message);
      } catch {
        // one bad listener must not stop the others
      }
    }
  }

  function isBackendCapable(record) {
    if (!record?.enabled) return false;
    try {
      const adapter = registry.get(record.adapterId);
      return typeof adapter.createBackend === 'function' && Boolean(adapter.server);
    } catch {
      return false;
    }
  }

  /** Environments that can act as a chat backend, without starting anything. */
  async function list() {
    const records = await store.list();
    return records.filter(isBackendCapable);
  }

  /**
   * The method names this environment's backend exposes, learned without
   * starting anything.
   *
   * Every adapter's `createBackend` returns a plain object of closures, so
   * building one over inert stubs costs nothing and spawns no CLI — which is
   * what lets a caller that only wants `listBots` skip the Codex app-server it
   * would otherwise cold-start to learn the answer. `null` means unknown (no
   * record, no factory, or the factory threw), and callers fall back to starting
   * the environment.
   */
  async function methodsOf(environmentId) {
    if (methodSets.has(environmentId)) return methodSets.get(environmentId);
    const record = await store.get(environmentId).catch(() => null);
    if (!record) return null;
    let adapter;
    try {
      adapter = registry.get(record.adapterId);
    } catch {
      return null;
    }
    const methods = probeMethods(adapter, record);
    // A null is deliberately not cached: "unknown" must not become permanent, or
    // one failed probe would cost this optimisation for the rest of the process.
    if (methods) methodSets.set(environmentId, methods);
    return methods;
  }

  function probeMethods(adapter, record) {
    if (typeof adapter?.createBackend !== 'function') return null;
    try {
      const backend = adapter.createBackend(inertOptions(adapter, record));
      if (!backend || typeof backend !== 'object') return null;
      return new Set(Object.keys(backend).filter((name) => typeof backend[name] === 'function'));
    } catch {
      return null;
    }
  }

  /** Wire-safe description for the manifest and the app's backend picker. */
  async function describe() {
    return (await list()).map((record) => {
      const adapter = registry.get(record.adapterId);
      const status = environmentState?.get?.(record.id) ?? {};
      return {
        id: record.id,
        label: record.label,
        kind: 'environment',
        adapterId: record.adapterId,
        capabilities: adapter.capabilities ?? [],
        workspaceRoot: record.workspacePolicy?.defaultRoot,
        state: status.state ?? (record.enabled ? 'stopped' : 'disabled'),
        ...(status.probe?.cliVersion ? { cliVersion: status.probe.cliVersion } : {}),
      };
    });
  }

  /** Ensure the environment's server is up and return a backend bound to it. */
  async function get(environmentId) {
    const record = await store.get(environmentId);
    if (!record) throw new Error(`environment "${environmentId}" not found`);
    if (!isBackendCapable(record)) {
      throw new Error(`environment "${environmentId}" cannot act as a chat backend`);
    }
    const adapter = registry.get(record.adapterId);

    // A per-turn CLI has nothing to supervise between turns: the backend spawns
    // a process per message and history lives on disk.
    if (adapter.server?.transport === 'per-turn') {
      const cached = backends.get(environmentId);
      if (cached) return cached.backend;
      const backend = adapter.createBackend({ record });
      backends.set(environmentId, { key: 'per-turn', backend });
      return backend;
    }

    const isStdio = adapter.server?.transport === 'stdio';
    // Resolved once here rather than only inside the factory: an HTTP backend
    // attached to an operator's own server may still need to authenticate to
    // it (Hermes requires a bearer token on every route), and that is the
    // backend's concern, not the supervisor's.
    const credentials = await resolveCredentials(record);
    let server = servers.get(environmentId);
    if (!server) {
      // HTTP servers can be shared with an operator's own instance; a stdio
      // server is bound to its pipe and is always ours.
      const factory = createServer ?? (isStdio ? createStdioServer : createNativeServer);
      server = factory({
        record,
        adapter,
        vault,
        credentials,
        buildEnvironment,
        onDiagnostic,
        ...(isStdio ? { onNotification: (message) => fanOut(environmentId, message) } : {}),
      });
      servers.set(environmentId, server);
    }

    const remembered = unavailable.get(environmentId);
    if (remembered && now() < remembered.retryAt) throw remembered.error;
    let handle;
    try {
      handle = await server.ensureRunning();
    } catch (error) {
      markUnavailable(environmentId, error);
      throw error;
    }
    unavailable.delete(environmentId);
    // A stdio backend is bound to one pipe, so a respawn must rebind rather than
    // hand back the backend wrapped around the dead child's rpc.
    const key = handle.baseUrl ?? `stdio:${handle.generation ?? 0}`;
    const cached = backends.get(environmentId);
    if (cached?.key === key) return cached.backend;

    const backend = isStdio
      ? adapter.createBackend({
          rpc: handle.rpc,
          cwd: record.workspacePolicy?.defaultRoot,
          // One connection multiplexes every thread, so the backend needs the
          // raw stream to await its own turn.
          subscribe: (handler) => subscribe(environmentId, handler),
        })
      : adapter.createBackend({ baseUrl: handle.baseUrl, credentials, record });
    backends.set(environmentId, { key, backend });
    return backend;
  }

  /**
   * Remember a server that would not start, with the window before the next
   * attempt. The supervisor's own start timeout (30s for an HTTP server) is paid
   * once per window instead of once per request, and the refusal the caller sees
   * is the real one, unchanged.
   */
  function markUnavailable(environmentId, error) {
    const attempts = (unavailable.get(environmentId)?.attempts ?? 0) + 1;
    const step = BACKOFF_STEPS_MS[Math.min(attempts - 1, BACKOFF_STEPS_MS.length - 1)];
    unavailable.set(environmentId, { error, attempts, retryAt: now() + step });
  }

  /**
   * Credentials the operator deliberately bound to this environment. Only these
   * are injected; nothing is inherited from the Gate's own environment.
   */
  async function resolveCredentials(record) {
    const credentials = {};
    for (const [envName, ref] of Object.entries(record.credentialBindings ?? {})) {
      if (!vault) break;
      const value = await vault.get(ref).catch(() => undefined);
      if (typeof value === 'string' && value) credentials[envName] = value;
    }
    return credentials;
  }

  async function stopAll() {
    for (const server of servers.values()) await server.stop().catch(() => undefined);
    servers.clear();
    backends.clear();
    methodSets.clear();
    unavailable.clear();
  }
}

/** Inert transports for a capability probe: nothing here can reach a process. */
function inertOptions(adapter, record) {
  const transport = adapter.server?.transport;
  if (transport === 'per-turn') return { record };
  if (transport === 'stdio') {
    return {
      rpc: refusingRpc(),
      cwd: record.workspacePolicy?.defaultRoot,
      subscribe: () => () => {},
    };
  }
  return { baseUrl: 'http://127.0.0.1:0', credentials: {}, record };
}

/** An rpc whose every call refuses, in case a factory touches it while building. */
function refusingRpc() {
  return new Proxy({}, {
    get(_target, property) {
      if (typeof property === 'symbol') return undefined;
      return () => Promise.reject(new Error('backend capability probe: no app-server'));
    },
  });
}
