import { probeVersion } from './shared.mjs';

export const codexAdapter = {
  adapterId: 'codex',
  adapterRevision: '1',
  supportedCliVersions: '0.142.x',
  protocolVersions: { jsonl: '1', app_server: 'experimental' },
  capabilities: ['exec', 'jsonl', 'mcp'],
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
