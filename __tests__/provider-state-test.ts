import { groupProviderModels, providerUiState } from '@/lib/gateway/provider-state';
import type { ProviderSnapshot } from '@/lib/gateway/provider-types';

type AuthState = ProviderSnapshot['auth']['state'];
type ReadinessState = ProviderSnapshot['readiness']['state'];

function snapshotWith(
  auth: AuthState,
  readiness: ReadinessState,
  mode: ProviderSnapshot['mode'] = 'oauth',
): ProviderSnapshot {
  return {
    id: 'anthropic',
    label: 'Anthropic',
    providerType: 'anthropic',
    mode,
    auth: { state: auth, credentialCustodian: 'gate' },
    readiness: { state: readiness, checkedAt: '2026-01-01T00:00:00.000Z' },
    catalog: { state: 'fresh', source: 'live', generation: 1, models: [] },
  };
}

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

describe('providerUiState', () => {
  it('shows a disconnected OAuth provider as needing sign-in, not as ready', () => {
    // The bug: readiness still read ready, so the badge fell through to the raw
    // enum and a provider with no grant showed "ready".
    expect(providerUiState(snapshotWith('disconnected', 'ready'))).toBe('Needs sign-in');
  });

  it('shows an in-flight grant renewal as refreshing sign-in', () => {
    expect(providerUiState(snapshotWith('refreshing', 'ready'))).toBe('Refreshing sign-in');
  });

  it('labels an unavailable readiness state instead of echoing the enum', () => {
    expect(providerUiState(snapshotWith('ready', 'unavailable', 'api_key'))).toBe('Unavailable');
  });

  it('still reports a local service that is offline as such', () => {
    expect(providerUiState(snapshotWith('ready', 'unavailable', 'local_interface'))).toBe('Local service offline');
  });

  it('reads an unrecognised readiness or auth state as not ready', () => {
    expect(providerUiState(snapshotWith('ready', 'warming_up' as ReadinessState, 'api_key'))).toBe('Not ready');
    expect(providerUiState(snapshotWith('rotating' as AuthState, 'ready'))).toBe('Not ready');
  });

  it('keeps Ready only when readiness and auth are both ready', () => {
    expect(providerUiState(snapshotWith('ready', 'ready'))).toBe('Ready');
  });

  it('never returns a raw lowercase enum for any auth and readiness pair', () => {
    const authStates: AuthState[] = ['missing', 'authorizing', 'ready', 'refreshing', 'needs_reauth', 'denied', 'disconnected'];
    const readinessStates: ReadinessState[] = ['ready', 'degraded', 'unavailable', 'disabled'];
    const modes: ProviderSnapshot['mode'][] = ['api_key', 'oauth', 'local_interface'];
    for (const auth of authStates) {
      for (const readiness of readinessStates) {
        for (const mode of modes) {
          expect(providerUiState(snapshotWith(auth, readiness, mode))).toMatch(/^[A-Z]/);
        }
      }
    }
  });
});
