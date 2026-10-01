/**
 * RUNS-3, provider half: `refreshCapabilities` answers whether its reads
 * landed.
 *
 * It wrapped its whole body in `try { … } catch { /* ignore *\/ }` and never
 * rethrew, and the capability and manifest reads it did await carried their own
 * `.catch(() => …)` — so a dead `/health`, a refused capability catalog and a
 * manifest fetch that exhausted its retries all reached a caller's
 * `Promise.all([refreshCapabilities(), refreshGateways()])` as a *fulfilled*
 * promise. The pull ended its spinner cleanly, cleared whatever notice was
 * there, and told the operator the data was fresh when none of it had been
 * re-read.
 *
 * The answer is a boolean and never a throw: every existing caller ignores the
 * value, and an individual refusal is still swallowed rather than thrown through
 * a surface with no way to say anything about it.
 */
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
import type { ConnectionStatus, GatewayProfile, HermesSession } from '@/lib/gateway/types';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';
import type { GatewayManifest } from '@/lib/portal/manifest';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

const mockState = {
  gateways: [] as GatewayProfile[],
  activeId: null as string | null,
  settings: { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' },
  /** What the manifest seam serves, keyed by URL; absent means "never answered". */
  manifests: new Map<string, GatewayManifest | null>(),
};

jest.mock('@/lib/gateway/storage', () => ({
  loadGateways: jest.fn(async () => mockState.gateways.map((item) => ({ ...item }))),
  saveGateways: jest.fn(async () => undefined),
  removeGatewayIds: jest.fn(async () => mockState.gateways.map((item) => ({ ...item }))),
  upsertGateway: jest.fn(async (gateway: GatewayProfile) => {
    mockState.gateways = mockState.gateways.some((item) => item.id === gateway.id)
      ? mockState.gateways.map((item) => (item.id === gateway.id ? { ...gateway } : item))
      : [...mockState.gateways, { ...gateway }];
    return mockState.gateways.map((item) => ({ ...item }));
  }),
  removeGateway: jest.fn(async () => mockState.gateways.map((item) => ({ ...item }))),
  addGatewayProfile: jest.fn(async (profile: GatewayProfile) => ({
    profile,
    gateways: [...mockState.gateways, profile],
  })),
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
    // Nothing in the map is the "retries exhausted" answer the real seam returns.
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

const GATE_MANIFEST = {
  manifest: 'versutus-gateway/v1',
  kind: 'versutus-gate',
  name: 'Versutus Gate',
  endpoints: { health: '/health', models: '/v1/models', chat: '/v1/chat/completions' },
  auth: { schemes: ['bearer'] },
} as unknown as GatewayManifest;

const MOVED_GATE_MANIFEST = { ...GATE_MANIFEST, name: 'Versutus Gate (moved)' } as unknown as GatewayManifest;

const HELLO = { type: 'hello-ok', protocol: 1, server: { version: '0.18.0' } };
const SESSION = { id: 'live-session', title: 'Live', createdAt: 0 } as unknown as HermesSession;
const HEALTHY = { status: 'ok' };

/** Which gateway-side reads answer, and how. Set per test. */
const reads = {
  healthFails: false,
  capabilitiesFails: false,
};

function mockMakeClient(callbacks: PortalClientCallbacks): PortalClient {
  let sessionId: string | undefined;
  const client = {
    connectionStatus: 'disconnected' as ConnectionStatus,
    statusDetail: '',
    authRejected: false,
    botId: undefined,
    connect: async () => {
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
    healthCheck: async () => {
      if (reads.healthFails) throw new Error('health refused');
      return HEALTHY;
    },
    rpcRequest: async () => ({ data: [] }),
    streamChat: async () => 'pong',
    getModels: async () => [{ id: 'm1', object: 'model' }],
    getCapabilities: async () => {
      if (reads.capabilitiesFails) throw new Error('capabilities refused');
      return { chat: true, models: true };
    },
    getSessions: async () => [SESSION],
    createSession: async () => SESSION,
    getSessionMessages: async () => [],
    stopRun: async () => undefined,
    setBotId: () => undefined,
    setBackendId: () => undefined,
    suspendReconnect: () => undefined,
    resumeReconnect: () => undefined,
    listBots: async () => [{ id: 'scout', displayName: 'Scout' }],
  };
  return client as unknown as PortalClient;
}

const mockClients: PortalClient[] = [];

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

let renderer: TestRenderer.ReactTestRenderer | null = null;

async function settle(rounds = 10, ms = 1): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }
}

function profile(overrides: Partial<GatewayProfile> & { id: string; url: string }): GatewayProfile {
  return {
    name: overrides.id,
    kind: 'custom',
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
  await settle(6, 0);
}

/** Mount a live connection to a Gate whose manifest is on file. */
async function connectAlpha(): Promise<void> {
  const alpha = profile({ id: 'alpha', url: 'http://alpha.test:8642' });
  mockState.gateways = [alpha];
  mockState.activeId = alpha.id;
  mockState.manifests.set(alpha.url, GATE_MANIFEST);
  await mount();
  await settle(4, 2_000);
  expect(gatewayApi().status).toBe('connected');
}

beforeEach(() => {
  jest.useFakeTimers();
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.settings = { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' };
  mockState.manifests = new Map();
  reads.healthFails = false;
  reads.capabilitiesFails = false;
  mockClients.length = 0;
  observed.gateway = null;
  observed.chat = null;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    listener: (state: AppStateStatus) => void,
  ) => {
    return {
      remove: () => {
        void listener;
      },
    };
  }) as unknown as typeof AppState.addEventListener);
});

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = null;
    await act(async () => {
      doomed.unmount();
    });
  }
  jest.restoreAllMocks();
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('the capabilities refresh reports whether it read anything', () => {
  test('a refresh whose reads all land resolves true', async () => {
    await connectAlpha();

    let answer: boolean | undefined;
    await act(async () => {
      answer = await gatewayApi().refreshCapabilities();
    });

    expect(answer).toBe(true);
  });

  test('a dead /health reports false, and the last known manifest stays', async () => {
    await connectAlpha();
    expect(gatewayApi().activeManifest?.name).toBe('Versutus Gate');

    reads.healthFails = true;
    let answer: boolean | undefined;
    await act(async () => {
      answer = await gatewayApi().refreshCapabilities();
    });

    // The refusal used to reach the caller as a fulfilled promise, which is how a
    // pull-to-refresh ended as a success over data nothing had re-read.
    expect(answer).toBe(false);
    expect(gatewayApi().activeManifest?.name).toBe('Versutus Gate');
  });

  test('a refused capability catalog reports false, and is still swallowed', async () => {
    await connectAlpha();
    reads.capabilitiesFails = true;

    let answer: boolean | undefined;
    // Never rejects: a caller with no error surface of its own must keep working.
    await act(async () => {
      answer = await gatewayApi().refreshCapabilities();
    });

    expect(answer).toBe(false);
  });

  test('a manifest that never answers reports false, and the served one stays', async () => {
    const alpha = profile({ id: 'alpha', url: 'http://alpha.test:8642' });
    mockState.gateways = [alpha];
    mockState.activeId = alpha.id;
    mockState.manifests.set(alpha.url, GATE_MANIFEST);
    await mount();
    await settle(4, 2_000);
    expect(gatewayApi().status).toBe('connected');
    // The Gate has moved: it now serves a different document from this host.
    mockState.manifests.set(alpha.url, MOVED_GATE_MANIFEST);

    let answer: boolean | undefined;
    await act(async () => {
      answer = await gatewayApi().refreshCapabilities();
    });
    expect(answer).toBe(true);
    expect(gatewayApi().activeManifest?.name).toBe('Versutus Gate (moved)');

    // Now the retries are exhausted and the seam answers null.
    mockState.manifests.delete(alpha.url);
    await act(async () => {
      answer = await gatewayApi().refreshCapabilities();
    });

    expect(answer).toBe(false);
    // A failed re-read keeps what the phone last knew rather than blanking it.
    expect(gatewayApi().activeManifest?.name).toBe('Versutus Gate (moved)');
  });

  test('with no active gateway there is nothing to refresh, and it is not a failure', async () => {
    mockState.settings = { autoConnect: false, onboardingComplete: true, voiceEngine: 'auto' };
    await mount();
    await settle();

    expect(gatewayApi().activeGateway).toBeNull();
    let answer: boolean | undefined;
    await act(async () => {
      answer = await gatewayApi().refreshCapabilities();
    });
    expect(answer).toBe(true);
  });

  test('a refused refresh leaves the roster and capabilities it already read in place', async () => {
    await connectAlpha();
    const before = gatewayApi().activeManifest;

    reads.capabilitiesFails = true;
    await act(async () => {
      await gatewayApi().refreshCapabilities();
    });

    // The reads that landed stay landed: reporting the failure is not rolling any
    // of them back.
    expect(gatewayApi().activeManifest).toBe(before);
  });
});