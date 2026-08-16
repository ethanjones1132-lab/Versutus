import { probeVersion } from './shared.mjs';
import { createCodexBackend } from '../backends/codex.mjs';

export const codexAdapter = {
  adapterId: 'codex',
  adapterRevision: '1',
  // 0.147 added 8 app-server methods and removed none; every method this
  // backend uses is present in both, so the range widens rather than forking.
  supportedCliVersions: '0.142.x-0.147.x',
  protocolVersions: { jsonl: '1', app_server: 'experimental' },
  capabilities: ['exec', 'jsonl', 'mcp', 'sessions', 'tools', 'models'],

  /**
   * Codex's app-server is newline-delimited JSON-RPC on stdio, not HTTP, so it
   * is spawned per Gate rather than attached to. `initialize` doubles as the
   * liveness check.
   */
  server: {
    transport: 'stdio',
    args: () => ['app-server'],
    handshake: {
      method: 'initialize',
      params: { clientInfo: { name: 'versutus-gate', version: '1.0.0' } },
    },
  },

  /** Threads, turns, models and approvals, owned by Codex itself. */
  createBackend(options) {
    return createCodexBackend(options);
  },
  operations: {
    exec: {
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
  async probe(executablePath) {
    return probeVersion(executablePath, {
      min: '0.142.0',
      maxExclusiveMajor: 1,
      protocol: 'jsonl',
      handshakeArgs: ['exec', '--json', '--probe'],
    });
  },
  async startRun() {
    throw new Error('codex startRun is implemented by the supervisor');
  },
};
