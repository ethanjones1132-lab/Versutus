import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { AppState, type AppStateStatus } from 'react-native';
import asyncStorage from '@react-native-async-storage/async-storage/jest/async-storage-mock';

import {
  GatewayProvider,
  useChatSurface,
  useGateway,
  type ChatSurfaceContextValue,
  type GatewayContextValue,
} from '@/context/gateway-provider';
import { readCached, writeCached } from '@/lib/cache/swr-store';
import type { ConnectionStatus, GatewayProfile, HermesSession, SessionMessage } from '@/lib/gateway/types';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';
import type { GatewayManifest } from '@/lib/portal/manifest';

// Every screen that draws the session list, the model picker and a thread's
// transcript used to wait for the network with nothing to show. These pin the
// last-known-good half: a paint from disk BEFORE the read, the read replacing
// it, a refused read leaving it alone, a copy for another thread never showing,
// and a deleted profile taking its copies with it.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

/**
 * A read the test can stall, so a cache paint and a network read can be made to
 * land in a chosen order. `match` holds every `getItem` whose key contains it
 * until `release` is called. The bytes are captured WHEN the read parks, not
 * when it is released: a live write that lands in between must not silently
 * turn a stale-paint test into a fresh-paint one.
 */
const mockStorageGate = { match: null as string | null, releases: [] as (() => void)[] };

jest.mock('@/lib/storage/key-value', () => {
  const backing = require('@react-native-async-storage/async-storage/jest/async-storage-mock');
  return {
    keyValueStorage: {
      getItem: async (key: string): Promise<string | null> => {
        if (mockStorageGate.match !== null && key.includes(mockStorageGate.match)) {
          const parked = backing.getItem(key);
          return new Promise<string | null>((resolve) => {
            mockStorageGate.releases.push(() => {
              void parked.then(resolve);
            });
          });
        }
        return backing.getItem(key);
      },
      setItem: async (key: string, value: string): Promise<void> => {
        await backing.setItem(key, value);
      },
      removeItem: async (key: string): Promise<void> => {
        await backing.removeItem(key);
      },
      getAllKeys: async (): Promise<string[]> => [...(await backing.getAllKeys())],
      multiRemove: async (keys: string[]): Promise<void> => {
        await backing.multiRemove(keys);
      },
    },
  };
});

const mockState = {
  gateways: [] as GatewayProfile[],
  activeId: null as string | null,
  settings: { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' },
  manifests: new Map<string, GatewayManifest | null>(),
  /** What the session list answers, and how long it takes. */
  sessions: [] as HermesSession[],
  sessionHolds: [] as Promise<HermesSession[]>[], // The connect's resume read, then the selector's.
  sessionFails: false,
  models: [{ id: 'm1', object: 'model' }],
  modelsHold: null as Promise<unknown> | null,
  modelsFails: false,
  history: [
    { id: 'm1', role: 'user', content: 'ping', timestamp: 1 },
    { id: 'm2', role: 'assistant', content: 'pong', timestamp: 2 },
  ] as SessionMessage[],
  historyHold: null as Promise<SessionMessage[]> | null,
  historyFails: false,
};

jest.mock('@/lib/gateway/storage', () => ({
  loadGateways: jest.fn(async () => mockState.gateways.map((item) => ({ ...item }))),
  saveGateways: jest.fn(async () => undefined),
  removeGatewayIds: jest.fn(async (ids: readonly string[]) => {
    mockState.gateways = mockState.gateways.filter((item) => !ids.includes(item.id));
    return mockState.gateways.map((item) => ({ ...item }));
  }),
  upsertGateway: jest.fn(async (gateway: GatewayProfile) => {
    mockState.gateways = mockState.gateways.some((item) => item.id === gateway.id)
      ? mockState.gateways.map((item) => (item.id === gateway.id ? { ...gateway } : item))
      : [...mockState.gateways, { ...gateway }];
    return mockState.gateways.map((item) => ({ ...item }));
  }),
  removeGateway: jest.fn(async (id: string) => {
    mockState.gateways = mockState.gateways.filter((item) => item.id !== id);
    if (mockState.activeId === id) mockState.activeId = null;
    return mockState.gateways.map((item) => ({ ...item }));
  }),
  addGatewayProfile: jest.fn(async (profile: GatewayProfile) => {
    mockState.gateways = [...mockState.gateways, { ...profile }];
    return { profile, gateways: mockState.gateways.map((item) => ({ ...item })) };
  }),
  repairDuplicateGateways: jest.fn(async () => ({
    gateways: mockState.gateways.map((item) => ({ ...item })),
    activeId: mockState.activeId,
  })),
  loadActiveGatewayId: jest.fn(async () => mockState.activeId),
  saveActiveGatewayId: jest.fn(async (id: string | null) => {
    mockState.activeId = id;
  }),
  createGatewayProfile: jest.fn((input: { name: string; url: string }) => ({
    ...input,
    id: `created-${input.name}`,
    createdAt: 0,
  })),
}));

jest.mock('@/lib/settings/app-settings', () => ({
  loadAppSettings: jest.fn(async () => ({ ...mockState.settings })),
  saveAppSettings: jest.fn(async (patch: Record<string, unknown>) => {
    mockState.settings = { ...mockState.settings, ...patch };
    return { ...mockState.settings };
  }),
}));

jest.mock('@/lib/gateway/probe', () => ({
  categorizeProbeError: () => '',
  GATEWAY_PROBE_PARALLEL_TIMEOUT_MS: 8_000,
  GATEWAY_PROBE_TIMEOUT_MS: 12_000,
  HIGH_PRIORITY_WAVE_SIZE: 4,
  probeGatewayCandidates: jest.fn(async () => ({ ok: false, url: '', error: 'no candidate' })),
  probeGatewayUrl: jest.fn(async (url: string) => ({ ok: true, url })),
  probeHighPriorityCandidates: jest.fn(async () => null),
}));

jest.mock('@/lib/portal/manifest', () => {
  const actual = jest.requireActual('@/lib/portal/manifest') as Record<string, unknown>;
  return {
    ...actual,
    fetchGatewayManifestWithLookupRetry: jest.fn(async (url: string) => mockState.manifests.get(url) ?? null),
  };
});

jest.mock('@/lib/discovery/scanner', () => ({
  isNativeDiscoveryAvailable: () => false,
  GatewayDiscoveryScanner: class {
    subscribe() {
      return () => undefined;
    }
    start() {}
  },
}));

jest.mock('@/lib/notifications/push-registration', () => ({
  deregisterWithGate: jest.fn(async () => undefined),
  syncPushRegistration: jest.fn(async () => undefined),
}));

jest.mock('@/lib/notifications/local', () => ({
  dismissGatewayDown: jest.fn(async () => undefined),
  dismissRunProgress: jest.fn(async () => undefined),
  dismissStaleRunProgress: jest.fn(async () => undefined),
  notifyApprovalRequired: jest.fn(async () => undefined),
  notifyGatewayDown: jest.fn(async () => undefined),
  notifyRunComplete: jest.fn(async () => undefined),
  notifyRunProgress: jest.fn(async () => undefined),
}));

jest.mock('@/lib/gateway/device-identity', () => ({
  loadOrCreateDeviceIdentity: jest.fn(async () => ({
    version: 1 as const,
    deviceId: 'device-under-test',
    publicKeyB64Url: 'pub',
    privateKeyB64Url: 'priv',
    createdAtMs: 0,
  })),
}));

jest.mock('@/lib/bot-avatar', () => ({ registerCrestFleet: jest.fn() }));

jest.mock('@/lib/portal/adapters', () => ({
  createClientForKind: jest.fn((kind: string, gateway: GatewayProfile, callbacks: PortalClientCallbacks) => {
    const client = mockMakeClient(callbacks);
    mockClients.push(client);
    return client;
  }),
}));

const HELLO = { type: 'hello-ok', protocol: 1, server: { version: '0.18.0' } };
const SESSION = { id: 'live-session', title: 'Live', createdAt: 0 } as unknown as HermesSession;
const HEALTHY = { status: 'ok' };

type FakeClient = PortalClient & { sessionReads: number; modelReads: number };

function mockMakeClient(callbacks: PortalClientCallbacks): FakeClient {
  let sessionId: string | undefined;
  const client = {
    connectionStatus: 'disconnected' as ConnectionStatus,
    statusDetail: '',
    authRejected: false,
    botId: undefined,
    sessionReads: 0,
    modelReads: 0,
    connect: async () => {
      client.connectionStatus = 'connecting';
      callbacks.onStatus?.('connecting', 'Connecting…');
      client.connectionStatus = 'connected';
      callbacks.onStatus?.('connected');
      callbacks.onHello?.(HELLO);
      callbacks.onHealthCheck?.(true, HEALTHY as never);
    },
    disconnect: () => {
      client.connectionStatus = 'disconnected';
    },
    updateProfile: () => undefined,
    get sessionId() {
      return sessionId;
    },
    set sessionId(id: string | undefined) {
      sessionId = id;
    },
    healthCheck: async () => HEALTHY,
    rpcRequest: async () => ({}),
    streamChat: async () => 'pong',
    getModels: async () => {
      client.modelReads += 1;
      if (mockState.modelsHold) return mockState.modelsHold;
      if (mockState.modelsFails) throw new Error('catalog refused');
      return mockState.models;
    },
    getCapabilities: async () => ({ chat: true, models: true }),
    getSessions: async () => {
      client.sessionReads += 1;
      const hold = mockState.sessionHolds.shift();
      if (hold) return hold;
      if (mockState.sessionFails) throw new Error('sessions refused');
      return mockState.sessions;
    },
    createSession: async () => SESSION,
    getSessionMessages: async () => {
      if (mockState.historyHold) return mockState.historyHold;
      if (mockState.historyFails) throw new Error('history refused');
      return mockState.history;
    },
    stopRun: async () => undefined,
    setBotId: () => undefined,
    setBackendId: () => undefined,
    suspendReconnect: () => undefined,
    resumeReconnect: () => undefined,
  };
  return client as unknown as FakeClient;
}

const mockClients: FakeClient[] = [];

const observed: { gateway: GatewayContextValue | null; chat: ChatSurfaceContextValue | null } = {
  gateway: null,
  chat: null,
};

function recordContexts(gateway: GatewayContextValue, chat: ChatSurfaceContextValue): null {
  observed.gateway = gateway;
  observed.chat = chat;
  return null;
}

function Capture() {
  return recordContexts(useGateway(), useChatSurface());
}

function gatewayApi(): GatewayContextValue {
  if (!observed.gateway) throw new Error('the provider has not mounted');
  return observed.gateway;
}

function chatApi(): ChatSurfaceContextValue {
  if (!observed.chat) throw new Error('the provider has not mounted');
  return observed.chat;
}

let renderer: TestRenderer.ReactTestRenderer | null = null;
let appStateListeners: ((state: AppStateStatus) => void)[] = [];

/** Drain promises and let whatever the code under test scheduled come due. */
async function settle(rounds = 14, ms = 1): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }
}

function profile(overrides: Partial<GatewayProfile> & { id: string; url: string }): GatewayProfile {
  return {
    name: overrides.id,
    kind: 'hermes',
    token: 'token-1',
    createdAt: 0,
    ...overrides,
  } as GatewayProfile;
}

/** Stage one profile and make it the active one on the next mount. */
function stageActive(profileToUse: Partial<GatewayProfile> & { id: string; url: string }): GatewayProfile {
  const staged = profile(profileToUse);
  mockState.gateways = [staged];
  mockState.activeId = staged.id;
  return staged;
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = TestRenderer.create(
      <GatewayProvider>
        <Capture />
      </GatewayProvider>,
    );
  });
  await settle();
}

function session(id: string, title: string): HermesSession {
  return { ...(SESSION as unknown as HermesSession), id, title } as HermesSession;
}

/** A promise the test settles itself, for pinning the order of two reads. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Put a cached copy straight into storage, bypassing `writeCached` — which
 * would also fill the store's memory front and hide the disk round trip this
 * test needs to stall.
 */
async function seedRawCache(storageKey: string, value: unknown): Promise<void> {
  await asyncStorage.setItem(storageKey, JSON.stringify({ v: 1, savedAt: Date.now(), value }));
}

function releaseStorageGate(): void {
  for (const release of mockStorageGate.releases.splice(0)) release();
}

beforeEach(() => {
  jest.useFakeTimers();
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.settings = { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' };
  mockState.manifests = new Map();
  mockState.sessions = [session('fresh-session', 'Fresh')];
  mockState.sessionHolds = [];
  mockState.sessionFails = false;
  mockState.models = [{ id: 'fresh-model', object: 'model' }];
  mockState.modelsHold = null;
  mockState.modelsFails = false;
  mockState.history = [
    { id: 'm1', role: 'user', content: 'ping', timestamp: 1 },
    { id: 'm2', role: 'assistant', content: 'pong', timestamp: 2 },
  ];
  mockState.historyHold = null;
  mockState.historyFails = false;
  mockStorageGate.match = null;
  mockStorageGate.releases = [];
  mockClients.length = 0;
  appStateListeners = [];
  observed.gateway = null;
  observed.chat = null;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    listener: (state: AppStateStatus) => void,
  ) => {
    appStateListeners.push(listener);
    return {
      remove: () => {
        const at = appStateListeners.indexOf(listener);
        if (at >= 0) appStateListeners.splice(at, 1);
      },
    };
  }) as unknown as typeof AppState.addEventListener);
});

afterEach(async () => {
  if (renderer) {
    await act(async () => {
      renderer?.unmount();
    });
    renderer = null;
  }
  jest.restoreAllMocks();
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('the session selector paints its last known list', () => {
  test('the cached page is on screen before the network read answers, then the read replaces it', async () => {
    // A gateway that has not answered yet, and a phone that already listed
    // this scope's threads earlier: the sheet must not be blank while it waits.
    // Two reads: the connect's own resume read, then the selector's.
    mockState.sessionHolds = [
      new Promise<HermesSession[]>(() => undefined),
      new Promise<HermesSession[]>(() => undefined),
    ];
    await writeCached('sessions', 'swr-sessions:cfg:', 'page1', [session('cached-thread', 'Cached')]);
    stageActive({ id: 'swr-sessions', url: 'http://sessions.test:8642' });
    await mount();

    await act(async () => {
      void gatewayApi().openSessionSelector();
    });
    await settle(3);

    expect(gatewayApi().sessionList.map((item) => item.id)).toEqual(['cached-thread']);
    expect(gatewayApi().sessionSelector.visible).toBe(true);

    // The read lands: it, and only it, replaces what the phone remembered.
    mockState.sessionHolds = [Promise.resolve([session('live-thread', 'Live')])];
    await act(async () => {
      await gatewayApi().openSessionSelector();
    });
    await settle();
    expect(gatewayApi().sessionList.map((item) => item.id)).toEqual(['live-thread']);
  });

  test('a refused read keeps the cached paint and still names the failure', async () => {
    mockState.sessionFails = true;
    await writeCached('sessions', 'swr-sessions-refused:cfg:', 'page1', [session('cached-thread', 'Cached')]);
    stageActive({ id: 'swr-sessions-refused', url: 'http://sessions.test:8642' });
    await mount();

    await act(async () => {
      await gatewayApi().openSessionSelector();
    });
    await settle();

    expect(gatewayApi().sessionList.map((item) => item.id)).toEqual(['cached-thread']);
    expect(gatewayApi().sessionListError).toBeTruthy();
  });

  test('a successful read becomes the copy the next open paints from', async () => {
    stageActive({ id: 'swr-sessions-write', url: 'http://sessions.test:8642' });
    await mount();

    mockState.sessions = [session('written-thread', 'Written')];
    await act(async () => {
      await gatewayApi().openSessionSelector();
    });
    await settle();

    const stored = await cachedValue<HermesSession[]>('sessions', 'swr-sessions-write:cfg:', 'page1');
    expect(stored?.map((item) => item.id)).toEqual(['written-thread']);
  });

  test('a refusal that lands BEFORE the remembered page still names itself', async () => {
    // The dangerous order: this device's storage read is slower than the Gate, so
    // the refusal is on screen first and the remembered list arrives last. The
    // sequence and client-identity checks cannot see a read landing, so without a
    // flag of its own the paint turned `{loaded:false, failed:true}` into a
    // loaded, untroubled list — and `sessionListCopy` then said nothing at all.
    const gateway = 'swr-sessions-race';
    const storageKey = `versutus:swr:sessions:${gateway}:cfg::page1`;
    await seedRawCache(storageKey, [session('remembered-thread', 'Remembered')]);
    mockStorageGate.match = storageKey;
    mockState.sessionFails = true;
    stageActive({ id: gateway, url: 'http://sessions-race.test:8642' });
    await mount();
    await settle();

    await act(async () => {
      await gatewayApi().openSessionSelector();
    });
    await settle(3);
    expect(gatewayApi().sessionList).toEqual([]);
    expect(gatewayApi().sessionListError).toBeTruthy();

    await act(async () => {
      releaseStorageGate();
    });
    await settle(3);

    // A failed first read is not "no sessions", and a remembered list must not
    // say otherwise: the operator is the one who has to be told.
    expect(gatewayApi().sessionList).toEqual([]);
    expect(gatewayApi().sessionListError).toBeTruthy();
  });

  test('with no gateway at all the remembered page is all there is', async () => {
    // `clientRef` is null while attaching and on disconnect, and the cached read
    // used to sit BEHIND the `!client` early return — so a selector opened in
    // exactly the window SPD-5 exists for showed an empty, unread list.
    mockState.settings = { autoConnect: false, onboardingComplete: true, voiceEngine: 'auto' };
    await writeCached('sessions', 'swr-sessions-offline:cfg:', 'page1', [session('cached-thread', 'Cached')]);
    stageActive({ id: 'swr-sessions-offline', url: 'http://sessions-offline.test:8642' });
    await mount();
    await settle();
    expect(mockClients).toHaveLength(0);

    await act(async () => {
      await gatewayApi().openSessionSelector();
    });
    await settle(3);

    expect(gatewayApi().sessionSelector.visible).toBe(true);
    expect(gatewayApi().sessionList.map((item) => item.id)).toEqual(['cached-thread']);
  });

  test('another scope\'s cached list never shows here', async () => {
    mockState.sessionHolds = [
      new Promise<HermesSession[]>(() => undefined),
      new Promise<HermesSession[]>(() => undefined),
    ];
    await writeCached('sessions', 'other-gateway:cfg:', 'page1', [session('wrong-thread', 'Wrong')]);
    stageActive({ id: 'swr-sessions-scope', url: 'http://sessions.test:8642' });
    await mount();

    await act(async () => {
      void gatewayApi().openSessionSelector();
    });
    await settle(3);

    expect(gatewayApi().sessionList).toEqual([]);
  });
});

describe('the model picker paints its last known catalog', () => {
  test('a cached catalog fills the sheet while the read runs, and the read replaces it', async () => {
    mockState.modelsHold = new Promise<unknown>(() => undefined);
    await writeCached('models', 'swr-models:cfg:', 'catalog', [{ id: 'cached-model', object: 'model' }]);
    stageActive({ id: 'swr-models', url: 'http://models.test:8642' });
    await mount();

    await act(async () => {
      void gatewayApi().openModelPicker('default');
    });
    await settle(3);

    expect(gatewayApi().modelCatalog).toEqual([{ id: 'cached-model', object: 'model' }]);
    // A remembered catalog is NOT a loaded one: the sheet has not heard from
    // the gateway, so it must not claim it has.
    expect(gatewayApi().modelCatalogLoaded).toBe(false);
    expect(gatewayApi().modelCatalogError).toBeUndefined();

    mockState.modelsHold = null;
    mockState.models = [{ id: 'live-model', object: 'model' }];
    await act(async () => {
      await gatewayApi().openModelPicker('default');
    });
    await settle();
    expect(gatewayApi().modelCatalog).toEqual([{ id: 'live-model', object: 'model' }]);
    expect(gatewayApi().modelCatalogLoaded).toBe(true);
  });

  test('a refused read keeps the cached catalog usable and names the failure', async () => {
    mockState.modelsFails = true;
    await writeCached('models', 'swr-models-refused:cfg:', 'catalog', [{ id: 'cached-model', object: 'model' }]);
    stageActive({ id: 'swr-models-refused', url: 'http://models.test:8642' });
    await mount();

    await act(async () => {
      await gatewayApi().openModelPicker('default');
    });
    await settle();

    expect(gatewayApi().modelCatalog).toEqual([{ id: 'cached-model', object: 'model' }]);
    expect(gatewayApi().modelCatalogError).toBe('catalog refused');
    expect(gatewayApi().modelCatalogLoaded).toBe(true);
  });

  test('a remembered catalog that lands AFTER the read never replaces it', async () => {
    // The dangerous order: this device's storage read is slower than the Gate, so
    // the models the host really offered arrive first and the remembered ones land
    // last. `isCurrent()` only knows the read sequence and the client identity,
    // neither of which moves when the read lands — so the paint used to leave the
    // sheet showing models that may no longer exist, marked loaded.
    const gateway = 'swr-models-race';
    const storageKey = `versutus:swr:models:${gateway}:cfg::catalog`;
    await seedRawCache(storageKey, [{ id: 'remembered-model', object: 'model' }]);
    mockStorageGate.match = storageKey;
    const network = deferred<unknown>();
    mockState.modelsHold = network.promise;
    stageActive({ id: gateway, url: 'http://models-race.test:8642' });
    await mount();

    await act(async () => {
      void gatewayApi().openModelPicker('default');
    });
    await settle(3);
    // Neither read has answered: the sheet has nothing to show yet.
    expect(gatewayApi().modelCatalog).toEqual([]);

    await act(async () => {
      network.resolve([{ id: 'live-model', object: 'model' }]);
    });
    await settle(3);
    expect(gatewayApi().modelCatalog).toEqual([{ id: 'live-model', object: 'model' }]);
    expect(gatewayApi().modelCatalogLoaded).toBe(true);

    await act(async () => {
      releaseStorageGate();
    });
    await settle(3);

    expect(gatewayApi().modelCatalog).toEqual([{ id: 'live-model', object: 'model' }]);
    expect(gatewayApi().modelCatalogLoaded).toBe(true);
    expect(gatewayApi().modelCatalogError).toBeUndefined();
  });

  test('a remembered catalog that lands AFTER a refusal does not cover it', async () => {
    const gateway = 'swr-models-refused-race';
    const storageKey = `versutus:swr:models:${gateway}:cfg::catalog`;
    await seedRawCache(storageKey, [{ id: 'remembered-model', object: 'model' }]);
    mockStorageGate.match = storageKey;
    mockState.modelsFails = true;
    stageActive({ id: gateway, url: 'http://models-refused-race.test:8642' });
    await mount();

    await act(async () => {
      await gatewayApi().openModelPicker('default');
    });
    await settle(3);
    expect(gatewayApi().modelCatalogError).toBe('catalog refused');
    expect(gatewayApi().modelCatalogLoaded).toBe(true);

    await act(async () => {
      releaseStorageGate();
    });
    await settle(3);

    // The refusal still names itself, the sheet does not claim a delivered
    // catalogue it never got, and a catalogue remembered AFTER the answer is
    // not presented as this open's.
    expect(gatewayApi().modelCatalogError).toBe('catalog refused');
    expect(gatewayApi().modelCatalogLoaded).toBe(true);
    expect(gatewayApi().modelCatalog).toEqual([]);
  });
});

describe('a thread paints its last known turns', () => {
  test('the cached thread is on screen before the history read answers, then the read replaces it', async () => {
    mockState.historyHold = new Promise<SessionMessage[]>(() => undefined);
    await writeCached(
      'history',
      'swr-history:live-session',
      'last40',
      [
        { id: 'c1', role: 'user', content: 'cached question', timestamp: 10 },
        { id: 'c2', role: 'assistant', content: 'cached answer', timestamp: 11 },
      ] as SessionMessage[],
    );
    stageActive({ id: 'swr-history', url: 'http://history.test:8642' });
    await mount();
    await settle(3);

    expect(chatApi().messages.map((message) => message.text)).toEqual(['cached question', 'cached answer']);
    // Still reading: the paint is a placeholder, not a loaded thread.
    expect(gatewayApi().historyLoading).toBe(true);

    mockState.historyHold = null;
    await act(async () => {
      await gatewayApi().reloadHistory();
    });
    await settle();
    expect(chatApi().messages.map((message) => message.text)).toEqual(['ping', 'pong']);
  });

  test('a cache read that lands AFTER the fresh read never paints over it', async () => {
    // The dangerous order: the cache read is slower than the network read, so
    // the turns the operator must see arrive first and the remembered ones land
    // last. `messagesRef` cannot catch this — it is only synced in an effect, so
    // until React commits it still reads as the blank thread it replaced — and a
    // guard that looks at the list therefore lets the stale paint through.
    const gateway = 'swr-history-race';
    const storageKey = `versutus:swr:history:${gateway}:live-session:last40`;
    await seedRawCache(storageKey, [
      { id: 'c1', role: 'user', content: 'remembered question', timestamp: 10 },
      { id: 'c2', role: 'assistant', content: 'remembered answer', timestamp: 11 },
    ]);
    mockStorageGate.match = storageKey;
    const network = deferred<SessionMessage[]>();
    mockState.historyHold = network.promise;
    stageActive({ id: gateway, url: 'http://history-race.test:8642' });
    await mount();
    await settle(3);
    // Neither read has answered: the thread is still blank, not stale.
    expect(chatApi().messages).toEqual([]);

    await act(async () => {
      network.resolve(mockState.history);
      releaseStorageGate();
    });
    await settle(3);

    // The read that owns the thread wins, whatever order the two land in.
    expect(chatApi().messages.map((message) => message.text)).toEqual(['ping', 'pong']);
    expect(gatewayApi().historyLoading).toBe(false);
  });

  test('a refused read leaves the cached paint on screen and still names the failure', async () => {
    mockState.historyFails = true;
    await writeCached(
      'history',
      'swr-history-refused:live-session',
      'last40',
      [{ id: 'c1', role: 'user', content: 'cached question', timestamp: 10 }] as SessionMessage[],
    );
    stageActive({ id: 'swr-history-refused', url: 'http://history.test:8642' });
    await mount();
    await settle(3);

    expect(chatApi().messages.map((message) => message.text)).toEqual(['cached question']);
    expect(gatewayApi().lastError).toMatch(/history could not be read/i);
  });

  test("another thread's cached turns never show here", async () => {
    mockState.historyHold = new Promise<SessionMessage[]>(() => undefined);
    await writeCached(
      'history',
      'swr-history-other:some-other-session',
      'last40',
      [{ id: 'c9', role: 'user', content: 'wrong thread', timestamp: 10 }] as SessionMessage[],
    );
    stageActive({ id: 'swr-history-other', url: 'http://history.test:8642' });
    await mount();
    await settle(3);

    expect(chatApi().messages).toEqual([]);
  });

  test('a successful read stores the newest 40 turns under this thread only', async () => {
    stageActive({ id: 'swr-history-write', url: 'http://history.test:8642' });
    await mount();
    await settle();

    const stored = await cachedValue<SessionMessage[]>('history', 'swr-history-write:live-session', 'last40');
    expect(stored?.map((message) => message.content)).toEqual(['ping', 'pong']);
    // Nothing was written under another thread's key.
    expect(await cachedValue('history', 'swr-history-write:some-other-session', 'last40')).toBeNull();
  });
});

describe('a deleted profile takes its copies with it', () => {
  test('the roster, session, model and history copies are all gone', async () => {
    stageActive({ id: 'swr-delete', url: 'http://delete.test:8642' });
    await mount();

    await writeCached('roster', 'swr-delete', 'bots', [{ id: 'a' }]);
    await writeCached('sessions', 'swr-delete:cfg:', 'page1', [session('s1', 'One')]);
    await writeCached('models', 'swr-delete:cfg:', 'catalog', [{ id: 'm1' }]);
    await writeCached('history', 'swr-delete:live-session', 'last40', []);

    await act(async () => {
      await gatewayApi().deleteGateway('swr-delete');
    });
    await settle();

    expect(await cachedValue('sessions', 'swr-delete:cfg:', 'page1')).toBeNull();
    expect(await cachedValue('history', 'swr-delete:live-session', 'last40')).toBeNull();
    expect(await cachedValue('models', 'swr-delete:cfg:', 'catalog')).toBeNull();
    expect(await cachedValue('roster', 'swr-delete', 'bots')).toBeNull();
  });
});

// The store's own reads, used here as the observation rather than a mock: the
// cache under test is the real one, over the AsyncStorage jest store. Null is
// what a cleared or never-written copy looks like.
function cachedValue<T>(namespace: string, gatewayId: string, key: string): Promise<T | null> {
  return readCached<T>(namespace, gatewayId, key).then((entry) => entry?.value ?? null);
}
