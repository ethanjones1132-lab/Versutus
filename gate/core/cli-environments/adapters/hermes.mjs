import { homedir } from 'node:os';
import { join } from 'node:path';

import { probeVersion } from './shared.mjs';
import { createHermesBackend } from '../backends/hermes.mjs';

export const hermesAdapter = {
  adapterId: 'hermes',
  adapterRevision: '1',
  supportedCliVersions: '0.18.x-0.20.x',
  protocolVersions: { acp: '1' },
  // `skills`, `diagnostics`, `cron` and `bots` are fronted by the Gate over
  // this backend's passthroughs. They are declared here because `backendCan(...)`
  // in manifest.mjs is what turns each into an advertised endpoint.
  capabilities: ['chat', 'tools', 'mcp', 'sessions', 'models', 'runs', 'skills', 'diagnostics', 'cron', 'bots'],
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
  createBackend({ baseUrl, credentials, record } = {}) {
    // Hermes authenticates every route with API_SERVER_KEY. Without it the
    // backend attaches happily and then 401s on the first real call.
    return createHermesBackend({
      baseUrl,
      apiKey: credentials?.API_SERVER_KEY ?? credentials?.HERMES_API_SERVER_KEY,
      profilesHome: process.env.HERMES_HOME || join(homedir(), '.hermes'),
      executablePath: record?.executable?.path,
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
  /**
   * Non-interactive argv per operation, read off the real CLI's usage line
   * (`hermes -h`): `-z PROMPT` runs one bounded task and prints the reply,
   * `--version` is the call probe() already makes. The long-lived service
   * stays with server/createBackend; this is the per-task spawn the
   * supervisor executes inside the workspace. Returns null for an operation
   * that needs a real terminal, so the run fails honestly instead of
   * completing empty.
   */
  runInvocation(operation, input = {}) {
    if (operation === 'status') return { args: ['--version'] };
    if (operation === 'prompt') {
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (!prompt) return null;
      return { args: ['-z', prompt] };
    }
    return null;
  },
};
