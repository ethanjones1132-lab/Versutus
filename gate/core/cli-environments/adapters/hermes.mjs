import { probeVersion } from './shared.mjs';
import { createHermesBackend } from '../backends/hermes.mjs';

export const hermesAdapter = {
  adapterId: 'hermes',
  adapterRevision: '1',
  supportedCliVersions: '0.18.x-0.20.x',
  protocolVersions: { acp: '1' },
  capabilities: ['chat', 'tools', 'mcp', 'sessions', 'models', 'runs'],
  operations: {
    prompt: {
      inputSchema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } },
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
  /**
   * Hermes runs as a long-lived service, not a per-turn CLI: 8642 is where an
   * operator's own instance already listens, so attach rather than spawn. The
   * spawn args are the documented fallback for a host with none running.
   */
  server: {
    defaultPort: 8642,
    healthPath: '/health',
    args: (port) => ['gateway', 'run', '--port', String(port)],
    portFromOutput: (line) => /listening on https?:\/\/[^:]+:(\d+)/.exec(line)?.[1],
  },

  /** Sessions, the 47-provider model catalog, runs and skills, owned by Hermes. */
  createBackend({ baseUrl, credentials } = {}) {
    // Hermes authenticates every route with API_SERVER_KEY. Without it the
    // backend attaches happily and then 401s on the first real call.
    return createHermesBackend({
      baseUrl,
      apiKey: credentials?.API_SERVER_KEY ?? credentials?.HERMES_API_SERVER_KEY,
    });
  },

  async probe(executablePath) {
    return probeVersion(executablePath, {
      min: '0.18.0',
      maxExclusiveMajor: 1,
      protocol: 'acp',
      handshakeArgs: ['--acp', '--probe'],
    });
  },
  async startRun() {
    throw new Error('hermes startRun is implemented by the supervisor');
  },
};
