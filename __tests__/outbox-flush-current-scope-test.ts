import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import {
  GatewayProvider,
  useGateway,
  type GatewayContextValue,
} from '@/context/gateway-provider';
import { loadOfflineQueue, saveOfflineQueue, type OfflineQueueItem } from '@/lib/gateway/session-persistence';
import type { ConnectionStatus, GatewayProfile, HermesSession, SessionMessage } from '@/lib/gateway/types';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';
import type { GatewayManifest } from '@/lib/portal/manifest';

// The outbox flush is one long-lived closure: it opens a Bot, sends a row, and
// only then moves to the next row. The operator can switch CLI environment or
// Bot while that loop is between rows, and the words must land in the
// conversation that is selected WHEN THE ROW GOES OUT — not the one the flush
// captured when the link came back. A row that carries a scope of its own (a
// `/run` destination, or a reply typed on a bot-message notice) still wins for
// its own send: the flush opens that Bot first, and the send must follow it.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

const mockState = {
  gateways: [] as GatewayProfile[],
  activeId: null as string | null,
  settings: { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' },
  manifests: new Map<string, GatewayManifest | null>(),
  history: [
    { id: 'm1', role: 'user', content: 'ping', timestamp: 1 },
    { id: 'm2', role: 'assistant', content: 'pong', timestamp: 2 },
  ] as SessionMessage[],
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
  /** Every Bot this client was scoped to, in order. */
  bots: (string | undefined)[];
};

function mockMakeClient(callbacks: PortalClientCallbacks, gateway: GatewayProfile): FakeClient {
  let sessionId: string | undefined;
  let connectionStatus: ConnectionStatus = 'disconnected';
  const client = {
    callbacks,
    streams: [] as StreamOptions[],
    bots: [] as (string | undefined)[],
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
    streamChat: async (
      _messages: unknown,
      onDelta: (text: string) => void,
      options?: StreamOptions,
    ) => {
      const request = options ?? {};
      client.streams.push(request);
      // The Gate takes the turn: the outbox releases a row only on this fact,
      // so a fake that never says it would leave every row owed and end the
      // batch at the first one.
      request.onAccepted?.(request.turnId ?? '');
      // Taken by the CALL, not by whatever the module variable holds when the
      // turn finally reaches the client.
      return (streamScripts.shift() ?? streamScript)(request, onDelta);
    },
    cancelTurn: async (_turnId: string) => undefined,
    getModels: async () => [{ id: 'm1', object: 'model' }],
    getCapabilities: async () => ({ chat: true, models: true }),
    getSessions: async () => [SESSION],
    createSession: async () => SESSION,
    getSessionMessages: async () => mockState.history,
    stopRun: async () => undefined,
    setBotId: (id?: string) => {
      client.bots.push(id);
    },
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

function liveClient(): FakeClient {
  const client = mockClients[mockClients.length - 1];
  if (!client) throw new Error('no client was created');
  return client;
}

let renderer: TestRenderer.ReactTestRenderer | null = null;

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
      React.createElement(GatewayProvider, null, React.createElement(Capture)),
    );
  });
  await settle();
}

beforeEach(async () => {
  jest.useFakeTimers();
  // The outbox is durable and the storage mock is a shared singleton: a row a
  // previous test parked would be flushed by this one's connect.
  await saveOfflineQueue([]);
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.settings = { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' };
  mockState.manifests = new Map();
  mockState.history = [
    { id: 'm1', role: 'user', content: 'ping', timestamp: 1 },
    { id: 'm2', role: 'assistant', content: 'pong', timestamp: 2 },
  ];
  mockClients.length = 0;
  streamScripts = [];
  observed.gateway = null;
  streamScript = async (_options, onDelta) => {
    onDelta('pong');
    return 'pong';
  };
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

/** Two CLI environments with a model each, so the payload names the scope. */
const ALPHA = {
  id: 'alpha',
  url: 'http://alpha.test:8642',
  backendModels: { 'claude-local': 'model-claude', 'codex-local': 'model-codex' },
  botModels: { alpha: 'model-alpha', beta: 'model-beta' },
};

describe('a flushed outbox line is sent in the scope selected when it goes out', () => {
  test('an environment the operator moved to while the row waited does not send it', async () => {
    stageActive(ALPHA);
    await mount();
    await act(async () => {
      gatewayApi().selectBackend('claude-local');
    });
    await settle();
    expect(gatewayApi().selectedBackendId).toBe('claude-local');

    await act(async () => {
      await gatewayApi().disconnectGateway();
    });
    await settleStream();
    await act(async () => {
      await gatewayApi().sendChatInput('sweep the garage');
    });
    await settleStream();
    const parked = await loadOfflineQueue();
    expect(parked.map((row) => row.text)).toEqual(['sweep the garage']);
    expect(parked[0].backendId).toBe('claude-local');

    // The operator moves to the other environment while the line waits. The row
    // remembers the one its words were typed under, so the flush restores that
    // before it sends — and the send must follow the restore, not the selection
    // this flush loop captured when the link came back.
    await act(async () => {
      gatewayApi().selectBackend('codex-local');
    });
    expect(gatewayApi().selectedBackendId).toBe('codex-local');

    await act(async () => {
      await gatewayApi().connectGateway(profile(ALPHA));
    });
    await settle(10, 20);

    const client = liveClient();
    expect(client.streams).toHaveLength(1);
    expect(client.streams[0].model).toBe('model-claude');
    // The row really went out; a test that only read the payload could pass on
    // a send that was refused and put back on the queue.
    expect(await loadOfflineQueue()).toEqual([]);
  });

  test('a Bot switch made while the flush is between rows scopes the next row to the new Bot', async () => {
    stageActive(ALPHA);
    await mount();
    let opened = false;
    await act(async () => {
      opened = await gatewayApi().openBot('alpha');
    });
    await settle();
    expect(opened).toBe(true);
    expect(gatewayApi().selectedBotId).toBe('alpha');

    await act(async () => {
      await gatewayApi().disconnectGateway();
    });
    await settleStream();
    // Two composer lines, both parked with no Bot of their own: the conversation
    // that is selected when each one is sent is the one it belongs in.
    await act(async () => {
      await gatewayApi().sendChatInput('first');
      await gatewayApi().sendChatInput('second');
    });
    await settleStream();
    expect((await loadOfflineQueue()).map((row) => row.text)).toEqual(['first', 'second']);

    // The first row's turn is still on the wire when the operator moves to the
    // other Bot Chat.
    let releaseFirst: () => void = () => undefined;
    const firstTurn = new Promise<void>((resolve) => {
      releaseFirst = () => resolve();
    });
    streamScripts.push(async (_options, onDelta) => {
      await firstTurn;
      onDelta('one');
      return 'one';
    });

    await act(async () => {
      await gatewayApi().connectGateway(profile(ALPHA));
    });
    for (let index = 0; index < 12 && liveClient().streams.length === 0; index += 1) {
      await settle(1, 20);
    }
    expect(liveClient().streams).toHaveLength(1);
    expect(liveClient().streams[0].model).toBe('model-alpha');

    await act(async () => {
      opened = await gatewayApi().openBot('beta');
    });
    await settle();
    expect(opened).toBe(true);
    expect(gatewayApi().selectedBotId).toBe('beta');

    await act(async () => {
      releaseFirst();
      await settle(6, 20);
    });
    await settle(10, 20);

    const client = liveClient();
    expect(client.streams).toHaveLength(2);
    expect(client.streams[1].model).toBe('model-beta');
    expect(await loadOfflineQueue()).toEqual([]);
  });

  test('a row that names its own Bot is still sent for that Bot', async () => {
    // A reply typed on a bot-message notice carries the Bot whose chat it was
    // for. The selection on screen is whatever it is; the flush opens that Bot
    // first, and the send belongs to it — not to the Bot this loop captured.
    stageActive(ALPHA);
    const parked: OfflineQueueItem = {
      id: 'notice-reply',
      text: 'on my way',
      gatewayId: 'alpha',
      createdAt: 1,
      botId: 'alpha',
    };
    await saveOfflineQueue([parked]);

    await mount();
    await settle(10, 20);

    const client = liveClient();
    expect(client.streams).toHaveLength(1);
    expect(client.streams[0].model).toBe('model-alpha');
    expect(client.bots).toContain('alpha');
    expect(await loadOfflineQueue()).toEqual([]);
  });
});
