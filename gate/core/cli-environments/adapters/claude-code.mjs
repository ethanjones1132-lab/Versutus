import { probeVersion } from './shared.mjs';

export const claudeCodeAdapter = {
  adapterId: 'claude-code',
  adapterRevision: '1',
  supportedCliVersions: '2.1.x',
  protocolVersions: { jsonl: '1' },
  capabilities: ['chat', 'stream-json', 'mcp'],
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
  async probe(executablePath) {
    return probeVersion(executablePath, {
      min: '2.1.0',
      maxExclusiveMajor: 3,
      protocol: 'jsonl',
      handshakeArgs: ['--output-format', 'stream-json', '--probe'],
    });
  },
  async startRun() {
    throw new Error('claude-code startRun is implemented by the supervisor');
  },
};
