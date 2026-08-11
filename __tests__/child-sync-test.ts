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
  test('creates a child profile for a newly advertised provider', () => {
    const { toUpsert, toRemove } = reconcileChildProfiles(PARENT, [provider()], [PARENT]);
    expect(toRemove).toEqual([]);
    expect(toUpsert).toHaveLength(1);
    expect(toUpsert[0]).toMatchObject({
      id: 'gw-parent::claude',
      name: 'Claude',
      url: 'http://gate.test:8760/p/claude',
      kind: 'custom',
      token: 'parent-token',
      parentId: 'gw-parent',
    });
  });

  test('is a no-op when the child already matches the provider', () => {
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
    expect(toRemove).toEqual([]);
  });

  test('updates an existing child when the parent token rotates, preserving its id and createdAt', () => {
    const existingChild: GatewayProfile = {
      id: 'gw-parent::claude',
      name: 'Claude',
      url: 'http://gate.test:8760/p/claude',
      kind: 'custom',
      token: 'stale-token',
      parentId: 'gw-parent',
      createdAt: 2000,
    };
    const { toUpsert, toRemove } = reconcileChildProfiles(PARENT, [provider()], [PARENT, existingChild]);
    expect(toRemove).toEqual([]);
    expect(toUpsert).toHaveLength(1);
    expect(toUpsert[0]).toMatchObject({ id: 'gw-parent::claude', token: 'parent-token', createdAt: 2000 });
  });

  test('removes a child whose provider is no longer advertised', () => {
    const existingChild: GatewayProfile = {
      id: 'gw-parent::gone',
      name: 'Gone',
      url: 'http://gate.test:8760/p/gone',
      kind: 'custom',
      token: 'parent-token',
      parentId: 'gw-parent',
      createdAt: 2000,
    };
    const { toUpsert, toRemove } = reconcileChildProfiles(PARENT, [], [PARENT, existingChild]);
    expect(toUpsert).toEqual([]);
    expect(toRemove).toEqual(['gw-parent::gone']);
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

  test('handles multiple providers, adding one and removing another in the same pass', () => {
    const staleChild: GatewayProfile = {
      id: 'gw-parent::old',
      name: 'Old',
      url: 'http://gate.test:8760/p/old',
      kind: 'custom',
      token: 'parent-token',
      parentId: 'gw-parent',
      createdAt: 2000,
    };
    const { toUpsert, toRemove } = reconcileChildProfiles(
      PARENT,
      [provider(), provider({ id: 'grok', label: 'Grok', basePath: '/p/grok', models: ['grok-4'] })],
      [PARENT, staleChild],
    );
    expect(toRemove).toEqual(['gw-parent::old']);
    expect(toUpsert.map((p) => p.id).sort()).toEqual(['gw-parent::claude', 'gw-parent::grok']);
  });
});
