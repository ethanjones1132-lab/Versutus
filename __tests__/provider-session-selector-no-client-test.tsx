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
import type { ConnectionStatus, GatewayProfile, HermesSession, SessionMessage } from '@/lib/gateway/types';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';
import type { GatewayManifest } from '@/lib/portal/manifest';

// The Sessions sheet can be opened while `clientRef.current` is null — an attach
// in flight, a reconnect ladder mid-rebuild — and `openSessionSelector` issued no
// read at all in that window, leaving `sessionListState` at
// `{loaded: false, failed: false}`. The sheet reads that as
// "Reading sessions… / The gateway is answering." and nothing could settle it:
// only a close and reopen after a reconnect would. These pin that the open
// settles either way — the remembered page if there is one, an honest refusal
// if there is not.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

const mockState = {
  gateways: [] as GatewayProfile[],
  activeId: null as string | null,
  settings: { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' },
  manifests: new Map<string, GatewayManifest | null>(),
  /** What the Gate's history endpoint answers; the recovery ladder re-reads it. */
  history: [
    { id: 'm1', role: 'user', content: 'ping', timestamp: 1 },
    { id: 'm2', role: 'assistant', content: 'pong', timestamp: 2 },
  ] as SessionMessage[],
  /** False models a Gate whose session catalogue the phone could not read. */
  canManageSessions: true,
  /** True models a Gate too old to host /v1/chat/cancel. */
  cancelTurnRejects: false,
  /** A promise the manifest read waits on, so an attach can be held in flight. */
  manifestGate: null as Promise<void> | null,
  /** True models a Gate whose history read is refused (so a reload changes nothing). */
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
    fetchGatewayManifestWithLookupRetry: jest.fn(async (url: string) => {
      // A manifest read held open models an attach in flight: 
      // has already named the gateway active while  is still null.
      await mockState.manifestGate;
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

// Transcript writes are write-behind; the foreground/background edge has to
// force them. The rest of the module is the real one.
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
const SESSION = { id: 'live-session', title: 'Live', createdAt: 0 } as unknown as HermesSession;
const HEALTHY = { status: 'ok' };

type StreamOptions = NonNullable<Parameters<PortalClient['streamChat']>[2]>;
type StreamScript = (options: StreamOptions, onDelta: (text: string) => void) => Promise<string>;

type FakeClient = PortalClient & {
  callbacks: PortalClientCallbacks;
  /** Every stream this client was asked to run, in order. */
  streams: StreamOptions[];
  /** Every turn id Stop was asked to cancel, with whether the abort had landed. */
  cancels: { turnId: string; streamAborted: boolean }[];
  historyReads: number;
};

function mockMakeClient(callbacks: PortalClientCallbacks, gateway: GatewayProfile): FakeClient {
  let sessionId: string | undefined;
  let connectionStatus: ConnectionStatus = 'disconnected';
  const client = {
    callbacks,
    streams: [] as StreamOptions[],
    cancels: [] as { turnId: string; streamAborted: boolean }[],
    historyReads: 0,
    // A Gate that cannot manage sessions is the honest model for "the phone
    // holds no thread": the turn's session is whatever the Gate decides.
    canManageSessions: mockState.canManageSessions !== false,
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
    streamChat: async (
      _messages: unknown,
      onDelta: (text: string) => void,
      options?: StreamOptions,
    ) => {
      client.streams.push(options ?? {});
      return streamScript(options ?? {}, onDelta);
    },
    cancelTurn: async (turnId: string) => {
      client.cancels.push({
        turnId,
        streamAborted: client.streams.some((stream) => stream.signal?.aborted === true),
      });
      if (mockState.cancelTurnRejects) throw new Error('no cancel route');
    },
    getModels: async () => [{ id: 'm1', object: 'model' }],
    getCapabilities: async () => ({ chat: true, models: true }),
    getSessions: async () => (mockState.canManageSessions === false ? [] : [SESSION]),
    createSession: async () => SESSION,
    getSessionMessages: async () => {
      client.historyReads += 1;
      if (mockState.historyFails) throw new Error('history refused');
      return mockState.history;
    },
    stopRun: async () => undefined,
    setBotId: () => undefined,
    setBackendId: () => undefined,
    suspendReconnect: () => undefined,
    resumeReconnect: () => undefined,
  };
  void gateway;
  return client as unknown as FakeClient;
}

const mockClients: FakeClient[] = [];

let streamScript: StreamScript = async (_options, onDelta) => {
  onDelta('pong');
  return 'pong';
};

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

/** The transcript module's forced flush, which the lifecycle edge must call. */
function flushTranscriptsMock(): jest.Mock {
  const { flushTranscripts } = jest.requireMock('@/lib/gateway/transcript') as {
    flushTranscripts: jest.Mock;
  };
  return flushTranscripts;
}

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

beforeEach(() => {
  jest.useFakeTimers();
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.settings = { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' };
  mockState.manifests = new Map();
  mockState.manifestGate = null;
  mockState.canManageSessions = true;
  mockState.cancelTurnRejects = false;
  mockState.historyFails = false;
  mockState.history = [
    { id: 'm1', role: 'user', content: 'ping', timestamp: 1 },
    { id: 'm2', role: 'assistant', content: 'pong', timestamp: 2 },
  ];
  mockClients.length = 0;
  streamScript = async (_options, onDelta) => {
    onDelta('pong');
    return 'pong';
  };
  appStateListeners = [];
  observed.gateway = null;
  observed.chat = null;
  flushTranscriptsMock().mockClear();
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


// The Sessions sheet opens before its read lands, so the state it opens onto is
// what the operator sees first. With no client there is no read that can ever
// land: the list stayed `{sessions: [], loaded: false, failed: false}`, which
// the sheet renders as "Reading sessions… / The gateway is answering." — a claim
// nothing settles until the operator closes the sheet and reopens it after a
// reconnect. The reachable window is an attach in flight: `connectGateway` has
// already named the gateway active while `clientRef` is still null.
describe('PROV-4: the Sessions sheet settles when there is no client to ask', () => {
  /** Connect with the manifest read held open, so the attach never finishes. */
  async function attachInFlight(): Promise<void> {
    mockState.gateways = [profile({ id: 'alpha', url: 'http://alpha.test:8642' })];
    // Nothing active yet: the attach below is the one that names it active.
    mockState.activeId = null;
    let release!: () => void;
    mockState.manifestGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mount();
    await act(async () => {
      void gatewayApi().connectGateway(profile({ id: 'alpha', url: 'http://alpha.test:8642' })).catch(() => undefined);
    });
    await settle(2, 1);
    release();
    mockState.manifestGate = null;
  }

  test('a first open with no client reports the read as refused, not as reading', async () => {
    await attachInFlight();
    expect(gatewayApi().activeGateway?.id).toBe('alpha');
    expect(gatewayApi().sessionList).toEqual([]);
    expect(gatewayApi().sessionListLoaded).toBe(false);

    await act(async () => {
      gatewayApi().openSessionSelector();
    });
    await settle(2, 1);

    // The sheet reads `sessions.length === 0 && !sessionsLoaded && !sessionsError`
    // as "Reading sessions…". With an error the row cannot be taken for a read
    // that is still coming.
    expect(gatewayApi().sessionListError).toBe('Sessions could not be read.');
    expect(gatewayApi().sessionSelector.visible).toBe(true);
  });
});
