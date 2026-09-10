import { reconcileChildProfiles, syncChildProfiles } from '@/lib/gateway/child-sync';
import { upsertGateway } from '@/lib/gateway/storage';
import { secureKeyValueStorage } from '@/lib/storage/secure-key-value';
import type { GatewayManifestProvider } from '@/lib/portal/manifest';
import type { GatewayProfile } from '@/lib/gateway/types';

jest.mock('@/lib/storage/secure-key-value', () => ({
  secureKeyValueStorage: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

const mockGet = secureKeyValueStorage.getItem as jest.Mock;
const mockSet = secureKeyValueStorage.setItem as jest.Mock;
const GATEWAYS_KEY = 'versutus:gateways';

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

describe('syncChildProfiles', () => {
  const backing = new Map<string, string>();

  const flushMicrotasks = async () => {
    for (let i = 0; i < 25; i += 1) await Promise.resolve();
  };

  const stored = (): GatewayProfile[] => {
    const raw = backing.get(GATEWAYS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as GatewayProfile[];
  };

  const child: GatewayProfile = {
    id: 'gw-parent::claude',
    name: 'Claude',
    url: 'http://gate.test:8760/p/claude',
    kind: 'custom',
    token: 'parent-token',
    parentId: 'gw-parent',
    createdAt: 2000,
  };

  const hermes: GatewayProfile = {
    id: 'hermes-local',
    name: 'Hermes',
    url: 'http://127.0.0.1:8642',
    kind: 'hermes',
    token: 'listen-hermes',
    createdAt: 2000,
  };

  beforeEach(() => {
    backing.clear();
    mockGet.mockReset().mockImplementation(async (key: string) => backing.get(key) ?? null);
    mockSet.mockReset().mockImplementation(async (key: string, value: string) => {
      backing.set(key, value);
    });
    backing.set(GATEWAYS_KEY, JSON.stringify([PARENT, child, hermes]));
  });

  test('a pin written while retirement runs is still on the surviving gateway', async () => {
    let releaseFirst!: () => void;
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstSetStarted!: () => void;
    const firstSetSeen = new Promise<void>((resolve) => {
      firstSetStarted = resolve;
    });
    let setCount = 0;
    mockSet.mockImplementation(async (key: string, value: string) => {
      setCount += 1;
      if (setCount === 1) {
        firstSetStarted();
        await firstHold;
      }
      backing.set(key, value);
    });

    const pinWrite = upsertGateway({ ...PARENT, model: 'grok-4' });
    await firstSetSeen;

    // Retirement loads off the queue, so it still sees the unpinned snapshot.
    // The pin write is held. If retirement then saves that snapshot, releasing
    // the pin write still loses — the queued save of the pre-pin list wins.
    const retirement = syncChildProfiles(PARENT, [provider()]);
    await flushMicrotasks();

    releaseFirst();
    const { gateways: next, removedIds } = await Promise.all([pinWrite, retirement]).then(
      ([, retired]) => retired,
    );

    expect(next.find((item) => item.id === PARENT.id)?.model).toBe('grok-4');
    expect(stored().find((item) => item.id === PARENT.id)?.model).toBe('grok-4');
    expect(stored().map((item) => item.id).sort()).toEqual(['gw-parent', 'hermes-local']);
    expect(next.map((item) => item.id).sort()).toEqual(['gw-parent', 'hermes-local']);
    // The retire reports what it took, so the caller can retire the device
    // stores keyed by that id beside the profile.
    expect(removedIds).toEqual(['gw-parent::claude']);
  });

  test('the retire reports the ids it removed beside the list that survived', async () => {
    const { gateways, removedIds } = await syncChildProfiles(PARENT, [provider()]);
    expect(removedIds).toEqual(['gw-parent::claude']);
    expect(gateways.map((item) => item.id).sort()).toEqual(['gw-parent', 'hermes-local']);
    expect(stored().map((item) => item.id).sort()).toEqual(['gw-parent', 'hermes-local']);
  });

  test('a sync that retires nothing names no id and writes nothing', async () => {
    backing.set(GATEWAYS_KEY, JSON.stringify([PARENT, hermes]));
    const { gateways, removedIds } = await syncChildProfiles(PARENT, [provider()]);
    expect(removedIds).toEqual([]);
    expect(gateways.map((item) => item.id).sort()).toEqual(['gw-parent', 'hermes-local']);
    expect(mockSet).not.toHaveBeenCalled();
  });

  test("another parent's child is not reported as removed", async () => {
    const otherChild: GatewayProfile = { ...child, id: 'gw-other::claude', parentId: 'gw-other' };
    backing.set(GATEWAYS_KEY, JSON.stringify([PARENT, otherChild, hermes]));
    const { gateways, removedIds } = await syncChildProfiles(PARENT, [provider()]);
    expect(removedIds).toEqual([]);
    expect(gateways.map((item) => item.id).sort()).toEqual([
      'gw-other::claude',
      'gw-parent',
      'hermes-local',
    ]);
  });
});
