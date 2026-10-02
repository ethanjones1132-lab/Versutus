import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { AppState, type AppStateStatus } from 'react-native';

import {
  GatewayProvider,
  useGateway,
  type GatewayContextValue,
} from '@/context/gateway-provider';
import { loadOfflineQueue, saveOfflineQueue } from '@/lib/gateway/session-persistence';
import type { ConnectionStatus, GatewayProfile, HermesSession, SessionMessage } from '@/lib/gateway/types';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';
import type { GatewayManifest } from '@/lib/portal/manifest';

// A line parked in the durable outbox carries a gateway id, a Bot and a
// session, but no environment: `runTask` and `executeGatewaySlashCommand`
// resolve the backend from the live selection when the flush dispatches them.
// A `/run` typed under one backend therefore started under whichever backend
// was selected by the time the tailnet link came back, and a Hermes session's
// model pin is immutable, so the work ran where the operator did not type it.
// These pin that the row records the backend it was typed under and that the
// flush restores it before it dispatches — and that a row written before the
// field existed flushes exactly as it always did.

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
  /** Every CLI environment id the client was scoped to, in order. */
  backendIds: (string | undefined)[];
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
    backendIds: [] as (string | undefined)[],
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
      // Taken by the CALL, not by whatever the module variable happens to hold
      // when the turn finally reaches the client: a test that reassigns the
      // script mid-turn would otherwise be reading a stream it never started.
      return (streamScripts.shift() ?? streamScript)(options ?? {}, onDelta);
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
    setBackendId: (id?: string) => {
      client.backendIds.push(id);
    },
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

/** Scripts for the next streams, in order, when a turn must not share a script. */
let streamScripts: StreamScript[] = [];

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

/** Long enough to flush the 16ms stream batcher as well as the microtasks. */
async function settleStream(): Promise<void> {
  await settle(4, 20);
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

function stageActive(profileToUse: Partial<GatewayProfile> & { id: string; url: string }): void {
  const staged = profile(profileToUse);
  mockState.gateways = [staged];
  mockState.activeId = staged.id;
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
  // The outbox is durable and the storage mock is a shared singleton: a row a
  // previous test parked would be flushed by this one's connect and its turns
  // would be indistinguishable from this test's own.
  await saveOfflineQueue([]);
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.settings = { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' };
  mockState.manifests = new Map();
  mockState.canManageSessions = true;
  mockState.cancelTurnRejects = false;
  streamScripts = [];
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


// A send that a live turn owns the composer lock for is not a failure — it is
// words the operator typed and has not sent yet. Several send paths are not the
// composer (a notification quick reply, a resumed turn, a retry), so the guard
// inside `sendMessage` fires for them too, and every one of them used to be
// able to hear only that the call resolved.

// A queued slash line carries no scope of its own: `queueOfflineInput` parked the
// raw text, and at flush time `runTask` and `executeGatewaySlashCommand` resolve
// the environment from the live selection. The Bot half *is* carried and re-opened
// — that is why the defect is as narrow as it is — but a `/run` typed under
// `claude-local` and flushed after the operator switched to `codex-local` started
// there, and a Hermes session's model pin is immutable, so the work ran in an
// environment nobody typed it in.
describe('PROV-10: a queued line is dispatched in the environment it was typed in', () => {
  beforeEach(() => {
    stageActive({ id: 'alpha', url: 'http://alpha.test:8642' });
  });

  /** Park a `/run` while there is nothing to send it through. */
  async function parkRun(backendId?: string): Promise<void> {
    await mount();
    if (backendId !== undefined) {
      await act(async () => {
        gatewayApi().selectBackend(backendId);
      });
    }
    mockClients[0].backendIds.length = 0;
    await act(async () => {
      await gatewayApi().disconnectGateway();
    });
    await settleStream();
    await act(async () => {
      await gatewayApi().sendChatInput('/run sweep the garage');
    });
    await settleStream();
    const rows = await loadOfflineQueue();
    expect(rows.map((row) => row.text)).toEqual(['/run sweep the garage']);
  }

  test('the parked row records the backend it was typed under', async () => {
    await parkRun('claude-local');
    const rows = await loadOfflineQueue();
    expect(rows[0].backendId).toBe('claude-local');
  });

  test('a flush restores that backend before it dispatches the row', async () => {
    await parkRun('claude-local');

    // The operator moves to another environment while the line waits. There is no
    // client to scope yet — the phone is disconnected — so the switch is the live
    // selection alone, which is exactly what the flush used to dispatch against.
    await act(async () => {
      gatewayApi().selectBackend('codex-local');
    });
    expect(gatewayApi().selectedBackendId).toBe('codex-local');

    // The link comes back.
    await act(async () => {
      await gatewayApi().connectGateway(profile({ id: 'alpha', url: 'http://alpha.test:8642' }));
    });
    await settle(8, 20);

    expect(mockClients.some((client) => client.backendIds.includes('claude-local'))).toBe(true);
    const last = mockClients[mockClients.length - 1];
    expect(last.backendIds[last.backendIds.length - 1]).toBe('claude-local');
  });

  test('a row with no recorded backend flushes as it always did', async () => {
    await parkRun();
    // Legacy rows, and every line parked before this field existed.
    await act(async () => {
      gatewayApi().selectBackend('codex-local');
    });
    await act(async () => {
      await gatewayApi().connectGateway(profile({ id: 'alpha', url: 'http://alpha.test:8642' }));
    });
    await settle(6, 20);

    const last = mockClients[mockClients.length - 1];
    expect(last.backendIds).not.toContain(undefined);
  });
});
