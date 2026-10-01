import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import {
  GatewayProvider,
  useChatSurface,
  useGateway,
  type ChatSurfaceContextValue,
  type GatewayContextValue,
} from '@/context/gateway-provider';
import type { ConnectionStatus, GatewayProfile, HermesSession, SessionMessage } from '@/lib/gateway/types';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';
import type { GatewayManifest } from '@/lib/portal/manifest';

// A profile write is fire-and-forget: nothing awaits it, so a refusal used to
// leave an unhandled rejection and a change that never landed. And the write is
// built from whatever profile the caller had — which, mid-turn, is older than
// the model the operator just picked.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

const mockState = {
  gateways: [] as GatewayProfile[],
  activeId: null as string | null,
  settings: { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' },
  manifests: new Map<string, GatewayManifest | null>(),
  /**
   * The catalogue holds only the pinned model, and it is locked on this device:
   * the connect-time pin repair has nothing to fall back to, so the turn really
   * does start on `m-old`.
   */
  models: [{ id: 'm-old', object: 'model' }],
  /** True models a store that refuses every profile write. */
  refuseWrites: false,
  /** Every refusal the store handed back, for the unhandled-rejection sweep. */
  rejections: [] as unknown[],
};

jest.mock('@/lib/gateway/storage', () => ({
  loadGateways: jest.fn(async () => mockState.gateways.map((item) => ({ ...item }))),
  saveGateways: jest.fn(async () => undefined),
  removeGatewayIds: jest.fn(async (ids: readonly string[]) => {
    mockState.gateways = mockState.gateways.filter((item) => !ids.includes(item.id));
    return mockState.gateways.map((item) => ({ ...item }));
  }),
  upsertGateway: jest.fn(async (gateway: GatewayProfile) => {
    if (mockState.refuseWrites) {
      const refusal = new Error('secure storage refused the write');
      mockState.rejections.push(refusal);
      throw refusal;
    }
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
const HISTORY: SessionMessage[] = [
  { id: 'm1', role: 'user', content: 'ping', timestamp: 1 },
  { id: 'm2', role: 'assistant', content: 'pong', timestamp: 2 },
];

type StreamOptions = NonNullable<Parameters<PortalClient['streamChat']>[2]>;
type StreamScript = (options: StreamOptions, onDelta: (text: string) => void) => Promise<string>;

type FakeClient = PortalClient & { streams: StreamOptions[] };

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function mockMakeClient(callbacks: PortalClientCallbacks): FakeClient {
  let sessionId: string | undefined;
  let connectionStatus: ConnectionStatus = 'disconnected';
  const client = {
    streams: [] as StreamOptions[],
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
    streamChat: async (_messages: unknown, onDelta: (text: string) => void, options?: StreamOptions) => {
      client.streams.push(options ?? {});
      return streamScript(options ?? {}, onDelta);
    },
    getModels: async () => mockState.models,
    getCapabilities: async () => ({ chat: true, models: true }),
    getSessions: async () => [SESSION],
    createSession: async () => SESSION,
    getSessionMessages: async () => HISTORY,
    stopRun: async () => undefined,
    setBotId: () => undefined,
    setBackendId: () => undefined,
    suspendReconnect: () => undefined,
    resumeReconnect: () => undefined,
  };
  return client as unknown as FakeClient;
}

const mockClients: FakeClient[] = [];

let streamScript: StreamScript = async (_options, onDelta) => {
  onDelta('pong');
  return 'pong';
};

/** Ends the turn currently hanging in `hangUntilAborted`-shaped script. */
let releaseStream: (() => void) | null = null;

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
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

async function settle(rounds = 12, ms = 0): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    // Real timers here on purpose: an unhandled rejection is reported by the
    // process, not by React, and a faked event loop would never turn over.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
}

/** Long enough to flush the 16ms stream batcher as well as the microtasks. */
async function settleStream(): Promise<void> {
  await settle(4, 20);
}

beforeEach(() => {
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.settings = { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' };
  mockState.manifests = new Map();
  mockState.models = [{ id: 'm-old', object: 'model' }];
  mockState.refuseWrites = false;
  mockState.rejections.length = 0;
  mockClients.length = 0;
  releaseStream = null;
  streamScript = async (_options, onDelta) => {
    onDelta('pong');
    return 'pong';
  };
  observed.gateway = null;
  observed.chat = null;
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});

afterEach(async () => {
  if (renderer) {
    await act(async () => {
      renderer?.unmount();
    });
    renderer = null;
  }
  process.off('unhandledRejection', onUnhandled);
  jest.restoreAllMocks();
});

/** A profile already pinned to `m-old`, with a device lock recorded on it. */
function lockedProfile(): GatewayProfile {
  return {
    id: 'alpha',
    name: 'alpha',
    url: 'http://alpha.test:8642',
    kind: 'hermes',
    token: 'token-1',
    createdAt: 0,
    model: 'm-old',
    modelLocks: {
      'm-old': { model: 'm-old', reason: 'Unknown model', recordedAt: 1, profileId: 'alpha' },
    },
  } as unknown as GatewayProfile;
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

describe('SEND-6: a profile write that is refused is named, not swallowed', () => {
  beforeEach(() => {
    mockState.gateways = [lockedProfile()];
    mockState.activeId = 'alpha';
  });

  test('a refused write sets lastError and raises no unhandled rejection', async () => {
    await mount();
    await settle();
    expect(mockState.rejections).toHaveLength(0);

    // The store now refuses every write.
    mockState.refuseWrites = true;
    await act(async () => {
      gatewayApi().selectModel('m-new');
    });
    await settle();

    expect(mockState.rejections.length).toBeGreaterThan(0);
    expect(gatewayApi().lastError).toBe(
      'Could not save gateway settings: secure storage refused the write',
    );
    expect(unhandled).toEqual([]);
  });

  test('a refused model-lock write is named too', async () => {
    await mount();
    mockState.refuseWrites = true;

    // Clearing a lock is the other fire-and-forget write on the send path.
    await act(async () => {
      gatewayApi().clearModelLock('m-old');
    });
    await settle();

    expect(gatewayApi().lastError).toBe(
      'Could not save gateway settings: secure storage refused the write',
    );
    expect(unhandled).toEqual([]);
  });
});

describe('SEND-6: a write made during a turn keeps what the operator changed', () => {
  beforeEach(() => {
    mockState.gateways = [lockedProfile()];
    mockState.activeId = 'alpha';
  });

  test('clearing the lock on completion does not revert a mid-turn model pick', async () => {
    await mount();
    expect(gatewayApi().activeGateway?.model).toBe('m-old');

    // A turn starts on the locked model and is still running.
    streamScript = (options) =>
      new Promise<string>((resolve, reject) => {
        releaseStream = () => resolve('pong');
        options.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    await act(async () => {
      void gatewayApi().sendChatInput('explain').catch(() => undefined);
    });
    await settleStream();
    expect(chatApi().isSending).toBe(true);

    // The operator gives up on that model and picks another mid-turn.
    await act(async () => {
      gatewayApi().selectModel('m-new');
    });
    await settleStream();
    expect(gatewayApi().activeGateway?.model).toBe('m-new');

    // The turn finishes: the lock for the model it answered on is dropped, and
    // that write must carry the pick the operator just made.
    await act(async () => {
      releaseStream?.();
    });
    await settleStream();

    expect(gatewayApi().activeGateway?.model).toBe('m-new');
    const saved = mockState.gateways.find((item) => item.id === 'alpha');
    expect(saved?.model).toBe('m-new');
    // The lock itself is gone — that is what the completed turn proved.
    expect(saved?.modelLocks).toEqual({});
  });
});
