import { groupProviderModels } from '@/lib/gateway/provider-state';
import type { ProviderSnapshot } from '@/lib/gateway/provider-types';

const snapshots: ProviderSnapshot[] = [
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    providerType: 'nvidia-nim',
    mode: 'api_key',
    auth: { state: 'ready', credentialCustodian: 'gate' },
    readiness: { state: 'degraded', checkedAt: '2026-01-01T00:00:00.000Z' },
    catalog: {
      state: 'stale',
      source: 'last_known_good',
      generation: 1,
      models: [{ providerId: 'nvidia', id: 'meta/llama-3.1-8b-instruct', available: true }],
    },
  },
];

describe('groupProviderModels', () => {
  it('groups models by provider and preserves stale provenance', () => {
    const groups = groupProviderModels(snapshots);
    expect(groups[0].providerId).toBe('nvidia');
    expect(groups[0].models[0].catalogState).toBe('stale');
    expect(groups[0].models[0].id).toBe('meta/llama-3.1-8b-instruct');
  });
});
