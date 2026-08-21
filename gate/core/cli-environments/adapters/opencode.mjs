import { probeVersion } from './shared.mjs';
import { createOpenCodeBackend } from '../backends/opencode.mjs';

export const opencodeAdapter = {
  adapterId: 'opencode',
  adapterRevision: '1',
  supportedCliVersions: '1.17.x-1.18.x',
  protocolVersions: { acp: '1', jsonl: '1' },
  capabilities: ['acp', 'run-json', 'mcp', 'sessions', 'tools', 'models'],

  /**
   * The native server this CLI exposes. `opencode serve` announces its port on
   * stdout; 4096 is its conventional port, which is also where an operator's
   * own long-running instance usually is — so attach there before spawning.
   */
  server: {
    defaultPort: 4096,
    healthPath: '/session',
    args: (port) => ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
    portFromOutput: (line) => /listening on https?:\/\/[^:]+:(\d+)/.exec(line)?.[1],
  },

  /** Sessions, models, tools and approvals, owned by OpenCode itself. */
  createBackend(options) {
    return createOpenCodeBackend(options);
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
      maxExclusiveMajor: 2,
      protocol: 'acp',
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
