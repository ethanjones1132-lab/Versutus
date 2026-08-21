import { createNativeServer } from './native-server.mjs';
import { createStdioServer } from './stdio-server.mjs';

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
} = {}) {
  const servers = new Map();
  const backends = new Map();
  // A stdio server multiplexes every thread over one connection, so listeners
  // register here and filter by their own session.
  const listeners = new Map();

  return { get, list, describe, stopAll, isBackendCapable, subscribe };

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

    const handle = await server.ensureRunning();
    const key = handle.baseUrl ?? 'stdio';
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
  }
}
