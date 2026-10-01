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
import { upsertGateway } from '@/lib/gateway/storage';
import type { ConnectionStatus, GatewayProfile, HermesSession } from '@/lib/gateway/types';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';
import type { GatewayManifest } from '@/lib/portal/manifest';

// Every finding below is about what the provider does AROUND a client event —
// a lost health sample, a refused key, a switch, a delete — so the client is
// the seam and the provider's own state is the observation.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

const mockState = {
  gateways: [] as GatewayProfile[],
  activeId: null as string | null,
  settings: { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' },
  manifests: new Map<string, GatewayManifest | null>(),
  /** A manifest fetch that never answers, so an attach can be caught mid-flight. */
  manifestHold: null as Promise<GatewayManifest | null> | null,
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
  probeGatewayUrl: jest.fn(async (url: string) =>
    mockProbeOk ? { ok: true, url } : { ok: false, url, error: 'Network request failed' },
  ),
  probeHighPriorityCandidates: jest.fn(async () => null),
}));

jest.mock('@/lib/portal/manifest', () => {
  const actual = jest.requireActual('@/lib/portal/manifest') as Record<string, unknown>;
  return {
    ...actual,
    fetchGatewayManifestWithLookupRetry: jest.fn(async (url: string) => {
      if (mockState.manifestHold) return mockState.manifestHold;
      return mockState.manifests.get(url) ?? null;
    }),
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

const GATE_MANIFEST = {
  manifest: 'versutus-gateway/v1',
  kind: 'versutus-gate',
  name: 'Versutus Gate',
  endpoints: { health: '/health', models: '/v1/models', chat: '/v1/chat/completions' },
  auth: { schemes: ['bearer'] },
} as unknown as GatewayManifest;

const HISTORY = [
  { id: 'm1', role: 'user', content: 'ping', timestamp: 1 },
  { id: 'm2', role: 'assistant', content: 'pong', timestamp: 2 },
];

const HELLO = { type: 'hello-ok', protocol: 1, server: { version: '0.18.0' } };
const SESSION = { id: 'live-session', title: 'Live', createdAt: 0 } as unknown as HermesSession;
const HEALTHY = { status: 'ok' };

type SetStatus = (next: ConnectionStatus) => void;
type ConnectScript = (callbacks: PortalClientCallbacks, setStatus: SetStatus) => Promise<void>;

type FakeClient = PortalClient & {
  forceReconnectCalls: number;
  resumeReconnectCalls: number;
  streamChatCalls: number;
};

/** What every `connect()` does unless a test scripts something else. */
const CONNECT_OK: ConnectScript = async (callbacks, setStatus) => {
  setStatus('connecting');
  callbacks.onStatus?.('connecting', 'Connecting…');
  setStatus('connected');
  callbacks.onStatus?.('connected');
  callbacks.onHello?.(HELLO);
  callbacks.onHealthCheck?.(true, HEALTHY as never);
};

let connectScript: ConnectScript = CONNECT_OK;
let healthAnswer: () => Promise<unknown> = async () => HEALTHY;
/** Whether the gateway answers a probe. False models a gateway that is not up. */
let mockProbeOk = true;
const mockClients: FakeClient[] = [];

/**
 * A client whose whole event channel is the provider's own callbacks, built
 * the way a real adapter builds it: connect announces status, hello and the
 * health verdict, and the health answer is whatever this test wants the
 * foreground heal to see.
 */
function mockMakeClient(callbacks: PortalClientCallbacks): FakeClient {
  let sessionId: string | undefined;
  const client = {
    connectionStatus: 'disconnected' as ConnectionStatus,
    statusDetail: '',
    authRejected: false,
    botId: undefined,
    canManageSessions: true,
    forceReconnectCalls: 0,
    resumeReconnectCalls: 0,
    streamChatCalls: 0,
    connect: async () => {
      await connectScript(callbacks, (next) => {
        client.connectionStatus = next;
      });
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
    healthCheck: async () => healthAnswer(),
    rpcRequest: async () => ({}),
    streamChat: async () => {
      client.streamChatCalls += 1;
      return 'pong';
    },
    getModels: async () => [{ id: 'm1', object: 'model' }],
    getCapabilities: async () => ({ chat: true, models: true }),
    getSessions: async () => [SESSION],
    createSession: async () => SESSION,
    getSessionMessages: async () => HISTORY,
    stopRun: async () => undefined,
    setBotId: () => undefined,
    setBackendId: () => undefined,
    suspendReconnect: () => undefined,
    resumeReconnect: () => {
      client.resumeReconnectCalls += 1;
    },
    forceReconnect: () => {
      client.forceReconnectCalls += 1;
      client.connectionStatus = 'reconnecting';
      // A real adapter announces the re-verify before the attempt runs.
      callbacks.onStatus?.('reconnecting', 'Checking the connection');
    },
  };
  return client as unknown as FakeClient;
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

async function emitAppState(state: AppStateStatus): Promise<void> {
  await act(async () => {
    for (const listener of [...appStateListeners]) listener(state);
  });
  await settle(4);
}

beforeEach(() => {
  jest.useFakeTimers();
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.settings = { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' };
  mockState.manifests = new Map();
  mockState.manifestHold = null;
  mockClients.length = 0;
  connectScript = CONNECT_OK;
  healthAnswer = async () => HEALTHY;
  mockProbeOk = true;
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

describe('LIFE-1: a foreground heal that only missed its health check', () => {
  test('keeps the chat, hello and live session, and re-verifies the client in place', async () => {
    const alpha = profile({ id: 'alpha', url: 'http://alpha.test:8642' });
    mockState.gateways = [alpha];
    mockState.activeId = alpha.id;
    healthAnswer = async () => null;
    await mount();

    expect(gatewayApi().status).toBe('connected');
    expect(chatApi().messages.map((message) => message.text)).toEqual(['ping', 'pong']);
    expect(gatewayApi().activeHello).not.toBeNull();
    expect(gatewayApi().currentSessionId).toBe('live-session');

    await emitAppState('background');
    await emitAppState('active');

    expect(mockClients).toHaveLength(1);
    expect(mockClients[0].forceReconnectCalls).toBe(1);
    expect(gatewayApi().status).toBe('reconnecting');
    expect(chatApi().messages.map((message) => message.text)).toEqual(['ping', 'pong']);
    expect(gatewayApi().activeHello).not.toBeNull();
    expect(gatewayApi().currentSessionId).toBe('live-session');

    // The re-verify lands as an ordinary connect, and the thread is still the
    // one the operator was reading when the radio woke.
    await act(async () => {
      await mockClients[0].connect();
    });
    await settle();
    expect(gatewayApi().status).toBe('connected');
    expect(mockClients).toHaveLength(1);
    expect(chatApi().messages.map((message) => message.text)).toEqual(['ping', 'pong']);
    expect(gatewayApi().currentSessionId).toBe('live-session');
  });

  test('with no live client at all, the fast-path recovery still runs', async () => {
    const alpha = profile({ id: 'alpha', url: 'http://alpha.test:8642' });
    mockState.gateways = [alpha];
    mockState.activeId = alpha.id;
    mockProbeOk = false;
    await mount();
    expect(mockClients).toHaveLength(0);
    expect(gatewayApi().activeGateway?.id).toBe('alpha');

    mockProbeOk = true;
    await emitAppState('background');
    await emitAppState('active');

    // Nothing to re-verify, so the probe-and-reattach path is still how a
    // client-less app comes back — and it built one.
    expect(mockClients).toHaveLength(1);
    expect(gatewayApi().status).toBe('connected');
  });
});

describe('LIFE-2: a key the gateway refuses', () => {
  const REFUSAL = 'Gateway rejected the API key';

  beforeEach(() => {
    connectScript = async (callbacks, setStatus) => {
      setStatus('connecting');
      callbacks.onStatus?.('connecting', 'Connecting…');
      setStatus('disconnected');
      callbacks.onStatus?.('disconnected', REFUSAL, { authRejected: true });
      throw new Error(`${REFUSAL}.`);
    };
  });

  async function mountRefused(): Promise<void> {
    const alpha = profile({ id: 'alpha', url: 'http://alpha.test:8642', kind: 'custom' });
    mockState.gateways = [alpha];
    mockState.activeId = alpha.id;
    mockState.manifests.set(alpha.url, GATE_MANIFEST);
    await mount();
    expect(mockClients).toHaveLength(1);
  }

  test('is not retried, and keeps saying so', async () => {
    await mountRefused();

    // The first rung of the ladder, then everything up to its five-minute cap.
    await settle(4, 15_000);
    await settle(4, 5 * 60_000);

    expect(mockClients).toHaveLength(1);
    expect(gatewayApi().autoRetry).toBeNull();
    expect(gatewayApi().lastError).toContain(REFUSAL);
    expect(gatewayApi().probeMessage).toBe(
      'Gateway rejected the API key. Update it from the gateway settings.',
    );
  });

  test('a newly saved key is given one honest attempt', async () => {
    const alpha = profile({ id: 'alpha', url: 'http://alpha.test:8642', kind: 'custom' });
    mockState.gateways = [alpha];
    mockState.activeId = alpha.id;
    mockState.manifests.set(alpha.url, GATE_MANIFEST);
    await mount();
    expect(mockClients).toHaveLength(1);

    const saved = (await upsertGateway({ ...alpha, token: 'token-2' })).find(
      (item) => item.id === alpha.id,
    );
    if (!saved) throw new Error('the saved profile vanished');
    await act(async () => {
      // The refusal is this connect's own answer; the screen names it.
      await gatewayApi().connectGateway(saved).catch(() => undefined);
    });
    await settle();

    expect(mockClients).toHaveLength(2);
  });

  test('the retry button forces the one attempt the ladder would not make', async () => {
    await mountRefused();
    await settle(4, 15_000);
    await settle(4, 5 * 60_000);
    expect(mockClients).toHaveLength(1);

    await act(async () => {
      await gatewayApi().retryAutoConnect().catch(() => undefined);
    });
    await settle();
    expect(mockClients).toHaveLength(2);

    // And the ladder stops again: the refusal is still the answer.
    await settle(4, 5 * 60_000);
    expect(mockClients).toHaveLength(2);
  });
});

describe('LIFE-6: a switch while the new gateway is still being identified', () => {
  test('tells the truth about the window and queues a send instead of misrouting it', async () => {
    const alpha = profile({ id: 'alpha', url: 'http://alpha.test:8642' });
    const beta = profile({ id: 'beta', url: 'http://beta.test:8642', token: 'token-2' });
    mockState.gateways = [alpha, beta];
    mockState.activeId = alpha.id;
    await mount();
    expect(gatewayApi().status).toBe('connected');

    // Beta's manifest fetch is still in flight.
    mockState.manifestHold = new Promise<GatewayManifest | null>(() => undefined);
    await act(async () => {
      void gatewayApi().connectGateway(beta);
    });
    await settle(2);

    expect(gatewayApi().status).toBe('connecting');
    let outcome: string | undefined;
    await act(async () => {
      outcome = await gatewayApi().sendChatInput('is anyone there?');
    });
    expect(outcome).toBe('queued');
    expect(mockClients[0].streamChatCalls).toBe(0);
    expect(mockClients).toHaveLength(1);
  });
});

describe('LIFE-8: deleting the gateway that is still talking to the Gate', () => {
  test('tears the session down even when the Gate never answers', async () => {
    const alpha = profile({ id: 'alpha', url: 'http://alpha.test:8642', kind: 'custom' });
    mockState.gateways = [alpha];
    mockState.activeId = alpha.id;
    mockState.manifests.set(alpha.url, GATE_MANIFEST);
    await mount();
    expect(gatewayApi().status).toBe('connected');

    const { deregisterWithGate } = jest.requireMock('@/lib/notifications/push-registration') as {
      deregisterWithGate: jest.Mock;
    };
    deregisterWithGate.mockImplementation(() => new Promise<void>(() => undefined));

    let finished = false;
    await act(async () => {
      void gatewayApi().deleteGateway(alpha.id).then(() => {
        finished = true;
      });
    });
    await settle();

    expect(finished).toBe(true);
    expect(deregisterWithGate).toHaveBeenCalled();
    expect(gatewayApi().activeGateway).toBeNull();
    expect(gatewayApi().status).toBe('disconnected');
  });
});
