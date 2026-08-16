import { reconcileChildProfiles } from '@/lib/gateway/child-sync';
import type { GatewayManifestProvider } from '@/lib/portal/manifest';
import type { GatewayProfile } from '@/lib/gateway/types';

const PARENT: GatewayProfile = {
  id: 'gw-parent',
  name: 'My Gate',
  url: 'http://gate.test:8760',
  kind: 'custom',
  token: 'parent-token',
  createdAt: 1000,
};

function provider(overrides: Partial<GatewayManifestProvider> = {}): GatewayManifestProvider {
  return {
    id: 'claude',
    label: 'Claude',
    basePath: '/p/claude',
    models: ['claude-opus-5'],
    capabilities: { chat: true, streaming: true },
    ...overrides,
  };
}

describe('reconcileChildProfiles', () => {
  test('does not create child profiles for advertised providers', () => {
    const { toUpsert, toRemove } = reconcileChildProfiles(PARENT, [provider()], [PARENT]);
    expect(toUpsert).toEqual([]);
    expect(toRemove).toEqual([]);
  });

  test('retires stored provider child profiles back to the parent Gate', () => {
    const existingChild: GatewayProfile = {
      id: 'gw-parent::claude',
      name: 'Claude',
      url: 'http://gate.test:8760/p/claude',
      kind: 'custom',
      token: 'parent-token',
      parentId: 'gw-parent',
      createdAt: 2000,
    };
    const { toUpsert, toRemove } = reconcileChildProfiles(PARENT, [provider()], [PARENT, existingChild]);
    expect(toUpsert).toEqual([]);
    expect(toRemove).toEqual(['gw-parent::claude']);
  });

  test('never touches a gateway belonging to a different parent', () => {
    const otherParentChild: GatewayProfile = {
      id: 'gw-other::claude',
      name: 'Claude',
      url: 'http://other.test:8760/p/claude',
      kind: 'custom',
      token: 't',
      parentId: 'gw-other',
      createdAt: 2000,
    };
    const { toUpsert, toRemove } = reconcileChildProfiles(PARENT, [], [PARENT, otherParentChild]);
    expect(toUpsert).toEqual([]);
    expect(toRemove).toEqual([]);
  });

  test('keeps a direct Hermes/agent profile that is not a provider child', () => {
    const hermes: GatewayProfile = {
      id: 'hermes-local',
      name: 'Hermes',
      url: 'http://127.0.0.1:8642',
      kind: 'hermes',
      token: 't',
      createdAt: 2000,
    };
    const { toUpsert, toRemove } = reconcileChildProfiles(PARENT, [provider()], [PARENT, hermes]);
    expect(toUpsert).toEqual([]);
    expect(toRemove).toEqual([]);
  });
});
