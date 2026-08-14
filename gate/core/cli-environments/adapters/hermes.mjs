import { probeVersion } from './shared.mjs';

export const hermesAdapter = {
  adapterId: 'hermes',
  adapterRevision: '1',
  supportedCliVersions: '0.18.x',
  protocolVersions: { acp: '1' },
  capabilities: ['chat', 'tools', 'mcp'],
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
