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
import { saveOfflineQueue } from '@/lib/gateway/session-persistence';
import type { ConnectionStatus, GatewayProfile, HermesSession, SessionMessage } from '@/lib/gateway/types';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';
import type { GatewayManifest } from '@/lib/portal/manifest';

// Tapping a thread row validates it through `session.restore` before pinning
// it (`validateThreadSwitch`), and that read is a network hop bounded at 8s by
// the module — on a link about to drop, on a busy single-threaded Gate, or on
// one a tap and a gateway switch raced, the read is still open when the
// conversation underneath it has already changed. Pinning after that await is
// what carried the old gateway's session id into the new conversation.

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
  canManageSessions: true,
  /** True holds every `session.restore` read on the test's latch. */
  holdRestore: false,
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

type FakeClient = PortalClient & {
  callbacks: PortalClientCallbacks;
  /** Which gateway this client was built for. */
  gatewayId: string;
  /** Every session id a history read was issued for, in order. */
  historySessions: (string | undefined)[];
};

function mockSessionFor(gatewayId: string): HermesSession {
  return { id: `${gatewayId}-session`, title: 'Live', createdAt: 0 } as unknown as HermesSession;
}

function mockMakeClient(callbacks: PortalClientCallbacks, gateway: GatewayProfile): FakeClient {
  let sessionId: string | undefined;
  let connectionStatus: ConnectionStatus = 'disconnected';
  const client = {
    callbacks,
    gatewayId: gateway.id,
    historySessions: [] as (string | undefined)[],
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
    rpcRequest: async (method: string) => {
      // The validation read the tap waits on, held open by the test.
      if (method === 'session.restore' && mockState.holdRestore) await restoreLatch();
      return {};
    },
    streamChat: async () => 'pong',
    cancelTurn: async () => undefined,
    getModels: async () => [{ id: 'm1', object: 'model' }],
    getCapabilities: async () => ({ chat: true, models: true }),
    getSessions: async () => [mockSessionFor(gateway.id)],
    createSession: async () => mockSessionFor(gateway.id),
    getSessionMessages: async (id?: string) => {
      client.historySessions.push(id);
      return mockState.history;
    },
    setBotId: () => undefined,
    setBackendId: () => undefined,
    suspendReconnect: () => undefined,
    resumeReconnect: () => undefined,
    stopRun: async () => undefined,
  };
  return client as unknown as FakeClient;
}

const mockClients: FakeClient[] = [];

/** The latch every held `session.restore` read waits on. */
let restoreHeld: Promise<void> | null = null;
let restoreRelease!: () => void;

function restoreLatch(): Promise<void> {
  if (!restoreHeld) {
    restoreHeld = new Promise<void>((resolve) => {
      restoreRelease = resolve;
    });
  }
  return restoreHeld;
}

const observed: { gateway: GatewayContextValue | null; chat: ChatSurfaceContextValue | null } = {
  gateway: null,
  chat: null,
};

/** Where the mounted provider's two contexts are read from outside React. */
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
  mockState.canManageSessions = true;
  mockState.holdRestore = false;
  restoreHeld = null;
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

describe('PROV-13: a thread tap that lands after the gateway changed is refused', () => {
  const ALPHA = { id: 'alpha', url: 'http://alpha.test:8642' };
  const BETA = { id: 'beta', url: 'http://beta.test:8642' };

  beforeEach(() => {
    const staged = [profile(ALPHA), profile(BETA)];
    mockState.gateways = staged;
    mockState.activeId = ALPHA.id;
  });

  /** The tap, with its validation read held open by the latch. */
  async function startTap(sessionId: string): Promise<void> {
    mockState.holdRestore = true;
    await act(async () => {
      // Typed as void on the context; the tap is in flight from here until the
      // latch releases it, which is the window the test is about.
      void gatewayApi().selectSession(sessionId);
    });
    await settle(4, 20);
  }

  async function releaseTap(): Promise<void> {
    await act(async () => {
      restoreRelease();
    });
    await settle(6, 20);
  }

  test('a switch during the validation read leaves the new gateway on its own session', async () => {
    await mount();
    expect(gatewayApi().currentSessionId).toBe('alpha-session');

    await startTap('alpha-other-thread');

    // The operator switches gateway while the read is open.
    await act(async () => {
      await gatewayApi().connectGateway(profile(BETA));
    });
    await settle(8, 20);

    await releaseTap();

    expect(gatewayApi().currentSessionId).not.toBe('alpha-other-thread');
    // And the new Gate is never asked for the old gateway's thread.
    for (const client of mockClients) {
      expect(client.historySessions).not.toContain('alpha-other-thread');
    }
  });

  test('a disconnect during the validation read leaves the thread unpinned', async () => {
    await mount();
    await startTap('alpha-other-thread');

    await act(async () => {
      await gatewayApi().disconnectGateway();
    });
    await settle(4, 20);

    await releaseTap();

    expect(gatewayApi().currentSessionId).not.toBe('alpha-other-thread');
    expect(gatewayApi().lastError).toBeNull();
  });

  test('a tap whose read lands before anything changes still pins', async () => {
    await mount();
    await startTap('alpha-other-thread');
    await releaseTap();

    expect(gatewayApi().currentSessionId).toBe('alpha-other-thread');
  });
});