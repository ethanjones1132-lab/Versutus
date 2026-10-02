import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { AppState, type AppStateStatus } from 'react-native';

import {
  GatewayProvider,
  useGateway,
  type GatewayContextValue,
} from '@/context/gateway-provider';
import { saveOfflineQueue } from '@/lib/gateway/session-persistence';
import type { ConnectionStatus, GatewayProfile, HermesSession, SessionMessage } from '@/lib/gateway/types';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';
import type { GatewayManifest } from '@/lib/portal/manifest';

// `modelCatalog` is written by two places only — the cached paint and the live
// read — and nothing took it off screen. `resetSessionSelector` bumps the read
// sequence, which drops the superseded read's rows, but not the rows the
// previous scope painted: so switching Bot or backend and opening the picker
// listed the old environment's models under the new one's name for the whole
// read, and forever after a refused one.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

const mockState = {
  gateways: [] as GatewayProfile[],
  activeId: null as string | null,
  settings: { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' },
  manifests: new Map<string, GatewayManifest | null>(),
  history: [] as SessionMessage[],
  /** True holds every `getModels` read on the test's latch. */
  holdModels: false,
  /** True makes the catalogue read refuse. */
  modelsRefuse: false,
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

jest.mock('@/lib/gateway/transcript', () => ({
  ...jest.requireActual('@/lib/gateway/transcript'),
  flushTranscripts: jest.fn(async () => undefined),
}));

jest.mock('@/lib/portal/adapters', () => ({
  createClientForKind: jest.fn((kind: string, gateway: GatewayProfile, callbacks: PortalClientCallbacks) => {
    const client = mockMakeClient(callbacks, gateway);
    mockClients.push(client);
    return client;
  }),
}));

const HELLO = { type: 'hello-ok', protocol: 1, server: { version: '0.18.0' } };
const HEALTHY = { status: 'ok' };
const SESSION = { id: 'live-session', title: 'Live', createdAt: 0 } as unknown as HermesSession;

type FakeClient = PortalClient & {
  callbacks: PortalClientCallbacks;
  /** The CLI environment this client is currently scoped to. */
  backendId: string | undefined;
};

function mockMakeClient(callbacks: PortalClientCallbacks, gateway: GatewayProfile): FakeClient {
  let sessionId: string | undefined;
  let connectionStatus: ConnectionStatus = 'disconnected';
  const client = {
    callbacks,
    gatewayId: gateway.id,
    backendId: undefined as string | undefined,
    canManageSessions: true,
    get connectionStatus() {
      return connectionStatus;
    },
    statusDetail: '',
    authRejected: false,
    botId: undefined,
    connect: async () => {
      connectionStatus = 'connecting';
      callbacks.onStatus?.('connecting', 'Connecting…');
      connectionStatus = 'connected';
      callbacks.onStatus?.('connected');
      callbacks.onHello?.(HELLO);
      callbacks.onHealthCheck?.(true, HEALTHY as never);
    },
    disconnect: () => {
      connectionStatus = 'disconnected';
    },
    updateProfile: () => undefined,
    get sessionId() {
      return sessionId;
    },
    set sessionId(id: string | undefined) {
      sessionId = id;
    },
    setSessionId: (id: string | undefined) => {
      sessionId = id;
    },
    healthCheck: async () => HEALTHY,
    rpcRequest: async () => ({}),
    streamChat: async () => 'pong',
    cancelTurn: async () => undefined,
    // The real Gate answers for the scope the client is pinned to, so the rows
    // name it: a picker listing another environment's rows is visible.
    getModels: async () => {
      if (mockState.holdModels) await modelsLatch();
      if (mockState.modelsRefuse) throw new Error('Model catalog could not be read.');
      return [{ id: `${gateway.id}:${client.backendId ?? 'cfg'}`, object: 'model' }];
    },
    getCapabilities: async () => ({ chat: true, models: true }),
    getSessions: async () => [SESSION],
    createSession: async () => SESSION,
    getSessionMessages: async () => mockState.history,
    stopRun: async () => undefined,
    setBotId: () => undefined,
    setBackendId: (id?: string) => {
      client.backendId = id;
    },
    suspendReconnect: () => undefined,
    resumeReconnect: () => undefined,
  };
  return client as unknown as FakeClient;
}

const mockClients: FakeClient[] = [];

/** The latch every held catalogue read waits on. */
let modelsHeld: Promise<void> | null = null;
let modelsRelease!: () => void;

function modelsLatch(): Promise<void> {
  if (!modelsHeld) {
    modelsHeld = new Promise<void>((resolve) => {
      modelsRelease = resolve;
    });
  }
  return modelsHeld;
}

const observed: { gateway: GatewayContextValue | null } = { gateway: null };

/** Where the mounted provider context is read from outside React. */
function recordContext(gateway: GatewayContextValue): null {
  observed.gateway = gateway;
  return null;
}

function Capture() {
  return recordContext(useGateway());
}

function gatewayApi(): GatewayContextValue {
  if (!observed.gateway) throw new Error('the provider has not mounted');
  return observed.gateway;
}

let renderer: TestRenderer.ReactTestRenderer | null = null;
let appStateListeners: ((state: AppStateStatus) => void)[] = [];

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

beforeEach(async () => {
  jest.useFakeTimers();
  await saveOfflineQueue([]);
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.settings = { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' };
  mockState.manifests = new Map();
  mockState.history = [];
  mockState.holdModels = false;
  mockState.modelsRefuse = false;
  modelsHeld = null;
  mockClients.length = 0;
  appStateListeners = [];
  observed.gateway = null;
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

describe('PROV-8: the model picker never lists another scope\'s models', () => {
  beforeEach(() => {
    const staged = profile({ id: 'alpha', url: 'http://alpha.test:8642' });
    mockState.gateways = [staged];
    mockState.activeId = staged.id;
  });

  /** Open the picker and let the catalogue read land. */
  async function openPicker(): Promise<void> {
    await act(async () => {
      await gatewayApi().openModelPicker('default');
    });
    await settle();
  }

  function ids(): unknown[] {
    return gatewayApi().modelCatalog.map((model) => (model as { id: string }).id);
  }

  test('a backend switch takes the previous environment\'s rows off screen', async () => {
    await mount();
    await openPicker();
    expect(ids()).toEqual(['alpha:cfg']);

    await act(async () => {
      gatewayApi().selectBackend('codex-local');
    });
    await settle();

    expect(gatewayApi().selectedBackendId).toBe('codex-local');
    // Nothing of the other environment is on screen waiting to be picked.
    expect(ids()).toEqual([]);
  });

  test('the new environment\'s own rows replace them when its read lands', async () => {
    await mount();
    await openPicker();

    mockState.holdModels = true;
    await act(async () => {
      gatewayApi().selectBackend('codex-local');
    });
    await settle(4, 20);
    await act(async () => {
      void gatewayApi().openModelPicker('default');
    });
    await settle(4, 20);

    // While the new read is in flight the sheet has nothing to offer, and what it
    // does not offer is the old environment's models.
    expect(ids()).toEqual([]);

    await act(async () => {
      modelsRelease();
    });
    await settle();

    expect(ids()).toEqual(['alpha:codex-local']);
  });

  test('a refused read for a scope with nothing remembered shows the refusal, not the old rows', async () => {
    await mount();
    await openPicker();
    expect(ids()).toEqual(['alpha:cfg']);

    // A scope this device has never read, so there is no remembered catalogue
    // for it to paint: what the picker offers is the read and nothing else.
    await act(async () => {
      gatewayApi().selectBackend('gemini-local');
    });
    await settle();
    mockState.modelsRefuse = true;
    await openPicker();

    expect(gatewayApi().modelCatalogError).toBe('Model catalog could not be read.');
    expect(ids()).toEqual([]);
  });

  test('the same scope re-reads without blanking the picker', async () => {
    await mount();
    await openPicker();
    expect(ids()).toEqual(['alpha:cfg']);

    await openPicker();

    expect(ids()).toEqual(['alpha:cfg']);
    expect(gatewayApi().modelCatalogError).toBeUndefined();
  });
});