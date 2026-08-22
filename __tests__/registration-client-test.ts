import { createProviderClient } from '@/lib/gateway/provider-client';
import { createEnvironmentClient } from '@/lib/gateway/environment-client';

type Call = { method: string; params?: Record<string, unknown> };

function recorder(responses: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const request = async <T,>(method: string, params?: Record<string, unknown>) => {
    calls.push({ method, params });
    return (responses[method] ?? { ok: true }) as T;
  };
  return { calls, request };
}

const NIM_PROFILE = {
  id: 'nvidia-nim',
  label: 'NVIDIA NIM',
  providerType: 'nvidia-nim',
  mode: 'api_key' as const,
  protocol: 'openai_chat',
  defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
  origins: ['https://integrate.api.nvidia.com'],
};

describe('provider registration from the app', () => {
  it('lists the profiles the Gate ships', async () => {
    const { calls, request } = recorder({
      'providers.profiles.list': { profiles: [NIM_PROFILE] },
    });
    const profiles = await createProviderClient(request).listProfiles();
    expect(calls[0].method).toBe('providers.profiles.list');
    expect(profiles[0].defaultBaseUrl).toBe('https://integrate.api.nvidia.com/v1');
  });

  // The screen should hand over an id, a label and a chosen profile — not a
  // hand-assembled v2 registration document.
  it('assembles a full v2 registration from a profile choice', async () => {
    const { calls, request } = recorder();
    await createProviderClient(request).create({
      id: 'nvidia',
      label: 'NVIDIA NIM',
      profile: NIM_PROFILE,
    });
    expect(calls[0].method).toBe('providers.create');
    expect(calls[0].params).toEqual({
      schemaVersion: 2,
      kind: 'provider',
      id: 'nvidia',
      label: 'NVIDIA NIM',
      providerType: 'nvidia-nim',
      enabled: true,
      registration: {
        mode: 'api_key',
        protocol: 'openai_chat',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        credentialRef: 'provider/nvidia/api-key',
      },
      catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
      requestPolicy: { timeoutMs: 120000 },
    });
  });

  it('lets an operator override the base URL for a self-hosted endpoint', async () => {
    const { calls, request } = recorder();
    await createProviderClient(request).create({
      id: 'nim-local',
      profile: NIM_PROFILE,
      baseUrl: 'http://10.0.0.5:8000/v1',
    });
    const params = calls[0].params as { registration: { baseUrl: string }; label: string };
    expect(params.registration.baseUrl).toBe('http://10.0.0.5:8000/v1');
    expect(params.label).toBe('nim-local');
  });

  // Pasting the full endpoint URL is the obvious mistake: the models lookup
  // becomes <base>/chat/completions/models and 404s, with nothing explaining why.
  it.each([
    ['https://opencode.ai/zen/go/v1/chat/completions', 'https://opencode.ai/zen/go/v1'],
    ['https://opencode.ai/zen/go/v1/chat/completions/', 'https://opencode.ai/zen/go/v1'],
    ['https://opencode.ai/zen/go/v1/', 'https://opencode.ai/zen/go/v1'],
    ['https://opencode.ai/zen/go/v1', 'https://opencode.ai/zen/go/v1'],
    ['  https://opencode.ai/zen/v1  ', 'https://opencode.ai/zen/v1'],
  ])('normalizes %s to %s', async (entered, expected) => {
    const { calls, request } = recorder();
    await createProviderClient(request).create({
      id: 'zen',
      profile: { ...NIM_PROFILE, id: 'openai-compatible', providerType: 'openai-compatible' },
      baseUrl: entered,
    });
    expect((calls[0].params as { registration: { baseUrl: string } }).registration.baseUrl).toBe(expected);
  });

  it('rejects an id the Gate would refuse before making a round trip', async () => {
    const { calls, request } = recorder();
    await expect(
      createProviderClient(request).create({ id: 'Not Valid!', profile: NIM_PROFILE }),
    ).rejects.toThrow(/lowercase/i);
    expect(calls).toHaveLength(0);
  });
});

const OPENCODE_ADAPTER = {
  adapterId: 'opencode',
  adapterRevision: '1',
  supportedCliVersions: '1.17.x-1.18.x',
  protocols: ['acp', 'jsonl'],
  capabilities: ['acp', 'run-json', 'mcp'],
  operations: ['prompt', 'status', 'interactive'],
};

describe('CLI environment registration from the app', () => {
  it('lists the adapters the Gate ships', async () => {
    const { calls, request } = recorder({
      'environments.adapters.list': { adapters: [OPENCODE_ADAPTER] },
    });
    const adapters = await createEnvironmentClient(request).listAdapters();
    expect(calls[0].method).toBe('environments.adapters.list');
    expect(adapters[0].adapterId).toBe('opencode');
  });

  it('assembles a full environment record from an adapter choice', async () => {
    const { calls, request } = recorder();
    await createEnvironmentClient(request).create({
      id: 'opencode-local',
      label: 'OpenCode local',
      adapter: OPENCODE_ADAPTER,
      executablePath: 'C:\\Users\\me\\opencode.exe',
      workspaceRoot: 'C:\\Projects\\Versutus',
    });
    expect(calls[0].method).toBe('environments.create');
    expect(calls[0].params).toEqual({
      schemaVersion: 1,
      kind: 'cli-environment',
      id: 'opencode-local',
      label: 'OpenCode local',
      adapterId: 'opencode',
      executable: { path: 'C:\\Users\\me\\opencode.exe' },
      protocolPreference: ['acp', 'jsonl'],
      versionPolicy: { supported: '1.17.x-1.18.x', adapterRevision: '1' },
      providerRefs: [],
      workspacePolicy: {
        roots: ['C:\\Projects\\Versutus'],
        defaultRoot: 'C:\\Projects\\Versutus',
        defaultSandbox: 'read_only',
        allowAdditionalRoots: false,
      },
      lifecycle: { startup: 'on_demand', idleTimeoutSeconds: 300, maxConcurrentRuns: 1 },
      enabled: true,
      credentialBindings: {},
    });
  });

  it('carries chosen provider refs onto the record', async () => {
    const { calls, request } = recorder();
    await createEnvironmentClient(request).create({
      id: 'opencode-local',
      adapter: OPENCODE_ADAPTER,
      executablePath: 'C:\\opencode.exe',
      workspaceRoot: 'C:\\Projects',
      providerRefs: ['nvidia'],
    });
    expect((calls[0].params as { providerRefs: string[] }).providerRefs).toEqual(['nvidia']);
  });
});
