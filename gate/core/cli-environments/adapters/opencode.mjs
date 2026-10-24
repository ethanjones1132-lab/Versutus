import { probeVersion } from './shared.mjs';
import { createOpenCodeBackend, detectOpenCodeServerMajor } from '../backends/opencode.mjs';

export const opencodeAdapter = {
  adapterId: 'opencode',
  adapterRevision: '2',
  supportedCliVersions: '1.17.x-2.x',
  protocolVersions: { acp: '1', jsonl: '1' },
  capabilities: ['acp', 'run-json', 'mcp', 'sessions', 'tools', 'models', 'bots'],

  /**
   * The native server this CLI exposes. `opencode serve` announces its port on
   * stdout; 4096 is its conventional port, which is also where an operator's
   * own long-running instance usually is — so attach there before spawning.
   *
   * OpenCode 2.0 moved the whole API under `/api/*` and made authentication
   * always-on HTTP Basic `opencode:<password>` (v1 was opt-in Bearer). The
   * health route and auth scheme therefore depend on the detected major
   * version of the contacted server; `createNativeServer` resolves them once
   * per base URL through `detectMajor` (see cli-environments/native-server.mjs).
   */
  server: {
    defaultPort: 4096,
    healthPath: '/session',
    // v2: verified live 2026-10-21 against 2.0.32 — GET /api/info answers JSON
    // `{version, pid, …}`; the v1 `/session` route answers SPA HTML 200 there.
    healthPathFor: (major) => (major >= 2 ? '/api/info' : '/session'),
    authSchemeFor: (major) => (major >= 2 ? 'basic' : 'bearer'),
    /**
     * The v2 web UI's SPA catch-all answers 200 text/html on any unknown
     * path, so a bare `response.ok` can false-attach to a v2 server through
     * the v1 health route. Requiring a JSON body keeps that impossible.
     */
    healthJson: true,
    /**
     * Classify a contacted server as major 1 or 2. Shared with the backend
     * (backends/opencode.mjs) so the supervisor and the API client never
     * disagree about which protocol a server speaks.
     */
    detectMajor: (ctx) => detectOpenCodeServerMajor(ctx),
    args: (port) => ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
    portFromOutput: (line) => /listening on https?:\/\/[^:]+:(\d+)/.exec(line)?.[1],
    passwordFromOutput: (line) => /server password\s+(\S+)/i.exec(line)?.[1],
  },

  /** Sessions, models, tools and approvals, owned by OpenCode itself. */
  createBackend(options = {}) {
    // backendManager.get passes { baseUrl, credentials, record }; the health
    // check authenticates with credentials.OPENCODE_SERVER_PASSWORD, but the
    // backend reads only `password` — map it so a guarded server stays
    // authenticated past attach. An explicit password still wins.
    const { credentials, password, ...rest } = options;
    return createOpenCodeBackend({
      ...rest,
      password: password ?? credentials?.OPENCODE_SERVER_PASSWORD,
      directory: options.record?.workspacePolicy?.defaultRoot ?? null,
    });
  },
  operations: {
    prompt: {
      inputSchema: {
        type: 'object',
        required: ['prompt'],
        properties: { prompt: { type: 'string' } },
      },
      risk: 'workspace_write',
      machineReadable: true,
    },
    status: {
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      machineReadable: true,
    },
    interactive: {
      inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      risk: 'credential',
      machineReadable: false,
    },
  },
  async probe(executablePath) {
    return probeVersion(executablePath, {
      min: '1.17.0',
      // 2.x is supported: the v2 codepath branches on the detected server
      // major (backends/opencode.mjs). 3.x stays excluded until verified.
      maxExclusiveMajor: 3,
      protocol: 'acp',
      // Verified live against 2.0.32: exits 0 and prints the session JSON.
      handshakeArgs: ['session', 'list', '--format', 'json'],
    });
  },
  /**
   * Non-interactive argv per operation, read off `opencode run --help`:
   * `opencode run [message..]` runs one bounded task non-interactively, and
   * `--version` is the call probe() already makes. Returns null for an
   * operation that needs a real terminal, so the run fails honestly instead
   * of completing empty.
   */
  runInvocation(operation, input = {}) {
    if (operation === 'status') return { args: ['--version'] };
    if (operation === 'prompt') {
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (!prompt) return null;
      return { args: ['run', prompt] };
    }
    return null;
  },
};
