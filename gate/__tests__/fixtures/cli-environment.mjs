export function validEnvironment(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'cli-environment',
    id: 'hermes-local',
    label: 'Hermes',
    adapterId: 'hermes',
    executable: { path: 'C:\\Tools\\hermes.exe' },
    protocolPreference: ['acp', 'mcp'],
    versionPolicy: { supported: '0.18.x', adapterRevision: '1' },
    providerRefs: ['openai-main'],
    workspacePolicy: {
      roots: ['C:\\Projects\\Versutus'],
      defaultRoot: 'C:\\Projects\\Versutus',
      defaultSandbox: 'read_only',
      allowAdditionalRoots: false,
    },
    lifecycle: {
      startup: 'on_demand',
      idleTimeoutSeconds: 300,
      maxConcurrentRuns: 1,
    },
    enabled: true,
    ...overrides,
  };
}
