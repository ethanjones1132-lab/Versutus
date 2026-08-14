import { probeVersion } from './shared.mjs';

export const opencodeAdapter = {
  adapterId: 'opencode',
  adapterRevision: '1',
  supportedCliVersions: '1.17.x-1.18.x',
  protocolVersions: { acp: '1', jsonl: '1' },
  capabilities: ['acp', 'run-json', 'mcp'],
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
  async startRun() {
    throw new Error('opencode startRun is implemented by the supervisor');
  },
};
