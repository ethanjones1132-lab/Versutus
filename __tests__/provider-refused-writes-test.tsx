import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { AppState, type AppStateStatus } from 'react-native';

import {
  GatewayProvider,
  useChatSurface,
  useGateway,
  type ChatSurfaceContextValue,
  type GatewayContextValue,
} from '@/context/gateway-provider';
import { saveActiveGatewayId } from '@/lib/gateway/storage';
import { keyValueStorage } from '@/lib/storage/key-value';
import type { ConnectionStatus, GatewayProfile, HermesSession } from '@/lib/gateway/types';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';

// The provider's own writes are fire-and-forget, because the operator's action
// has already been answered by the time the disk is told. The values here are
// the ones that cannot be retyped: the operator's unsent words in the outbox,
// the run roster, and the active-gateway pin that decides where the next cold
// start lands. A device that refuses the write (an Android SQLite fault, a full
// disk, a Keystore hiccup) must therefore be told, not left to reject into the
// process with nothing on screen.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

const OFFLINE_QUEUE_KEY = 'versutus:offline-queue';
const ACTIVITY_RUNS_KEY = 'versutus:activity-runs';

const mockState = {
  gateways: [] as GatewayProfile[],
  activeId: null as string | null,
  settings: { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' },
  manifests: new Map<string, unknown>(),
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
  addGatewayProfile: jest.fn(async (profileToAdd: GatewayProfile) => {
    mockState.gateways = [...mockState.gateways, { ...profileToAdd }];
    return { profile: profileToAdd, gateways: mockState.gateways.map((item) => ({ ...item })) };
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
  probeGatewayUrl: jest.fn(async (url: string) =>
    mockProbeOk ? { ok: true, url } : { ok: false, url, error: 'Network request failed' },
  ),
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

jest.mock('@/lib/notifications/routine-sync', () => ({
  rearmRoutineNotifications: jest.fn(async () => undefined),
  syncRoutineNotification: jest.fn(async () => undefined),
  cancelRoutineNotification: jest.fn(async () => undefined),
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
  createClientForKind: jest.fn((_kind: string, _gateway: GatewayProfile, callbacks: PortalClientCallbacks) => {
    const client = mockMakeClient(callbacks);
    mockClients.push(client);
    return client;
  }),
}));

const HISTORY = [
  { id: 'm1', role: 'user', content: 'ping', timestamp: 1 },
  { id: 'm2', role: 'assistant', content: 'pong', timestamp: 2 },
];
const HELLO = { type: 'hello-ok', protocol: 1, server: { version: '0.18.0' } };
const SESSION = { id: 'live-session', title: 'Live', createdAt: 0 } as unknown as HermesSession;
const HEALTHY = { status: 'ok' };

let mockProbeOk = true;
const mockClients: PortalClient[] = [];

function mockMakeClient(callbacks: PortalClientCallbacks): PortalClient {
  let sessionId: string | undefined;
  const client = {
    connectionStatus: 'disconnected' as ConnectionStatus,
    statusDetail: '',
    authRejected: false,
    botId: undefined,
    canManageSessions: true,
    connect: async () => {
      client.connectionStatus = 'connected';
      callbacks.onStatus?.('connecting', 'Connecting…');
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
    getModels: async () => [{ id: 'm1', object: 'model' }],
    getCapabilities: async () => ({ chat: true, models: true }),
    getSessions: async () => [SESSION],
    createSession: async () => SESSION,
    getSessionMessages: async () => HISTORY,
    stopRun: async () => undefined,
    setBotId: () => undefined,
    setBackendId: () => undefined,
    suspendReconnect: () => undefined,
    resumeReconnect: () => undefined,
    forceReconnect: () => undefined,
  };
  return client as unknown as PortalClient;
}

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
async function settle(rounds = 12, ms = 1): Promise<void> {
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

/**
 * Refuse one storage key the way a device does: the write rejects, everything
 * else on the device still works.
 */
function refuseKey(key: string): void {
  const real = {
    setItem: keyValueStorage.setItem.bind(keyValueStorage),
    removeItem: keyValueStorage.removeItem.bind(keyValueStorage),
  };
  jest
    .spyOn(keyValueStorage, 'setItem')
    .mockImplementation(async (at: string, value: string) => {
      if (at === key) throw new Error(`disk is full (${key})`);
      return real.setItem(at, value);
    });
  jest
    .spyOn(keyValueStorage, 'removeItem')
    .mockImplementation(async (at: string) => {
      if (at === key) throw new Error(`disk is full (${key})`);
      return real.removeItem(at);
    });
}

beforeEach(async () => {
  jest.useFakeTimers();
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.settings = { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' };
  mockState.manifests = new Map();
  mockClients.length = 0;
  mockProbeOk = true;
  appStateListeners = [];
  observed.gateway = null;
  observed.chat = null;
  await keyValueStorage.multiRemove(await keyValueStorage.getAllKeys());
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

describe('a refused outbox write is named, not lost', () => {
  test('the operator\'s queued words are still on screen after a refused save', async () => {
    await mount();
    // Nothing to connect to, so the line is parked rather than sent — and the
    // park is the write whose lost value cannot be retyped.
    refuseKey(OFFLINE_QUEUE_KEY);

    await act(async () => {
      await gatewayApi().sendChatInput('run the sweep and tell me what you find');
    });
    await settle();

    // The refusal is told, in the one surface the provider owns for it.
    expect(gatewayApi().lastError).toContain('Queued messages could not be saved');
    // ...and the words themselves are still there to be flushed later.
    expect(chatApi().messages.some((message) => message.queued === true)).toBe(true);
  });

  test('the same refusal leaves no unhandled rejection behind', async () => {
    await mount();
    refuseKey(OFFLINE_QUEUE_KEY);
    const escaped: unknown[] = [];
    const collect = (reason: unknown): void => {
      escaped.push(reason);
    };
    process.on('unhandledRejection', collect);

    try {
      await act(async () => {
        await gatewayApi().sendChatInput('first line');
        await gatewayApi().sendChatInput('second line');
      });
      await settle();
      // A turn of macrotasks: an unhandled rejection is reported after the
      // microtask queue has drained, so the queue this test drives cannot miss
      // one.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });
    } finally {
      process.off('unhandledRejection', collect);
    }

    expect(escaped).toEqual([]);
  });
});

describe('a refused roster write is named, not lost', () => {
  test('the run roster survives a save the device would not take', async () => {
    refuseKey(ACTIVITY_RUNS_KEY);
    await mount();

    // The roster is written from the state that committed, so a refusal here is
    // the storage layer's answer and nothing about the roster in hand changes.
    expect(gatewayApi().activityRuns).toEqual([]);
    expect(gatewayApi().lastError).toContain('Activity could not be saved');
  });
});

describe('a refused roster read at launch does not erase the stored roster', () => {
  test('the on-disk runs survive a getItem that throws', async () => {
    const raw = JSON.stringify([
      {
        id: 'run-kept',
        prompt: 'keep me',
        status: 'complete',
        startedAt: 1,
        finishedAt: 2,
        events: [],
      },
    ]);
    await keyValueStorage.setItem(ACTIVITY_RUNS_KEY, raw);

    const realGet = keyValueStorage.getItem.bind(keyValueStorage);
    jest.spyOn(keyValueStorage, 'getItem').mockImplementation(async (at: string) => {
      if (at === ACTIVITY_RUNS_KEY) throw new Error('SQLite disk image is malformed');
      return realGet(at);
    });

    await mount();

    // The swallowed read leaves the in-memory roster empty so bootstrap can
    // settle. That empty list must not be written — saveActivityRuns([]) would
    // removeItem the key the refusal hid.
    expect(gatewayApi().isBootstrapped).toBe(true);
    expect(gatewayApi().activityRuns).toEqual([]);

    jest.mocked(keyValueStorage.getItem).mockRestore();
    expect(await keyValueStorage.getItem(ACTIVITY_RUNS_KEY)).toBe(raw);
  });
});

describe('a refused pin write is named, not lost', () => {
  test('a disconnect whose pin write is refused says so', async () => {
    const alpha = profile({ id: 'alpha', url: 'http://alpha.test:8642' });
    mockState.gateways = [alpha];
    mockState.activeId = alpha.id;
    await mount();
    expect(gatewayApi().status).toBe('connected');
    expect(gatewayApi().lastError).toBeNull();

    // SecureStore refuses: `runSecureStore` retries once and then throws, and
    // `allowInsecureFallback` throws outright when the store is absent in a
    // release build. Either way the pin the operator just cleared stays on disk.
    jest.mocked(saveActiveGatewayId).mockRejectedValue(new Error('Keystore is locked'));

    await act(async () => {
      gatewayApi().disconnectGateway();
    });
    await settle();

    expect(gatewayApi().status).toBe('disconnected');
    expect(gatewayApi().lastError).toContain('Could not clear the active gateway');
  });
});