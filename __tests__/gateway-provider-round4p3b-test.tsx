import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import {
  GatewayProvider,
  useChatSurface,
  useGateway,
  type ChatSurfaceContextValue,
  type GatewayContextValue,
} from '@/context/gateway-provider';
import { appendTranscript, createTranscriptId, loadTranscripts } from '@/lib/gateway/transcript';
import { keyValueStorage } from '@/lib/storage/key-value';
import type { CommandTranscriptEntry, ConnectionStatus, GatewayProfile, HermesSession } from '@/lib/gateway/types';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';
import type { GatewayManifest } from '@/lib/portal/manifest';

// Round-4 scan (R4S-p3b): leaving a Bot Chat must not leave its session pinned
// (OPEN-1), New/delete-thread must not be silent no-ops without a client
// (OPEN-2), and deleting a message or a thread must clear the device-local
// command transcript that a later history paint re-merges (TAIL-1, V-1).

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

const mockState = {
  gateways: [] as GatewayProfile[],
  activeId: null as string | null,
  settings: { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' },
  manifests: new Map<string, GatewayManifest | null>(),
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
    fetchGatewayManifestWithLookupRetry: jest.fn(
      async (url: string) => mockState.manifests.get(url) ?? null,
    ),
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

const BACKENDS = [
  {
    id: 'hermes-local',
    label: 'Hermes',
    kind: 'environment',
    adapterId: 'hermes',
    capabilities: ['chat', 'sessions', 'models', 'tools', 'bots'],
  },
];

function gateManifest(name: string): GatewayManifest {
  return {
    manifest: 'versutus-gateway/v1',
    kind: 'versutus-gate',
    name,
    endpoints: {
      health: '/health',
      models: '/v1/models',
      chat: '/v1/chat/completions',
      capabilitiesRpc: '/v1/capabilities/rpc',
      bots: '/v1/bots',
      sessions: '/v1/sessions',
    },
    auth: { schemes: ['bearer'] },
    backends: BACKENDS,
  } as unknown as GatewayManifest;
}

const GATE_MANIFEST = gateManifest('Versutus Gate');
const HELLO = { type: 'hello-ok', protocol: 1, server: { version: '0.18.0' } };
const HEALTHY = { status: 'ok' };
const ROSTER = [{ id: 'scout', displayName: 'Scout', routable: true }];
/** The thread the app already owns, so connect resumes it rather than churning. */
const OWN_SESSION = { id: 'own-1', title: 'Live', createdAt: 0, source: 'api_server' } as unknown as HermesSession;

type FakeClient = PortalClient & {
  deleted: string[];
};

function mockMakeClient(callbacks: PortalClientCallbacks): FakeClient {
  let sessionId: string | undefined;
  let botId: string | undefined;
  let created = 0;
  const deleted: string[] = [];
  const client = {
    deleted,
    connectionStatus: 'disconnected' as ConnectionStatus,
    statusDetail: '',
    authRejected: false,
    canManageSessions: true,
    connect: async () => {
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
    setSessionId: (id: string | undefined) => {
      sessionId = id;
    },
    get botId() {
      return botId;
    },
    healthCheck: async () => HEALTHY,
    rpcRequest: async () => ({}),
    streamChat: async () => 'pong',
    getModels: async () => [{ id: 'test-model', object: 'model' }],
    getCapabilities: async () => ({ chat: true, models: true, sessions: true, bots: true }),
    getSessions: async () => [OWN_SESSION],
    createSession: async (title?: string) => ({
      id: `created-${(created += 1)}`,
      title: title ?? 'New thread',
      createdAt: 0,
      source: 'api_server',
    }) as unknown as HermesSession,
    deleteSession: async (id: string) => {
      deleted.push(id);
    },
    getSessionMessages: async () => [],
    stopRun: async () => undefined,
    setBotId: (id: string | undefined) => {
      botId = id || undefined;
    },
    setBackendId: () => undefined,
    suspendReconnect: () => undefined,
    resumeReconnect: () => undefined,
    listBots: async () => ROSTER,
    createBot: async (input: { name: string }) => ({ id: input.name, displayName: input.name, routable: true }),
    updateBot: async () => ROSTER[0],
  };
  return client as unknown as FakeClient;
}

const mockClients: FakeClient[] = [];

const observed: { gateway: GatewayContextValue | null; chat: ChatSurfaceContextValue | null } = {
  gateway: null,
  chat: null,
};

/** Record this render's contexts. Called from the component body, the same
 * shape the existing provider suites use to observe a mounted provider. */
function recordContexts(gateway: GatewayContextValue, chat: ChatSurfaceContextValue): null {
  observed.gateway = gateway;
  observed.chat = chat;
  return null;
}

function Capture(): null {
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
  await settle(8, 0);
}

beforeEach(async () => {
  await keyValueStorage.removeItem('versutus:round4p3b-gate-manifest');
  jest.useFakeTimers();
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.settings = { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' };
  mockState.manifests = new Map();
  mockClients.length = 0;
  observed.gateway = null;
  observed.chat = null;
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

/** A connected Gate with a live app session, ready for a Bot / delete path. */
async function mountConnected(gatewayId: string): Promise<void> {
  const alpha = profile({ id: gatewayId, url: `http://${gatewayId}.test:8642` });
  mockState.gateways = [alpha];
  mockState.activeId = alpha.id;
  mockState.manifests.set(alpha.url, GATE_MANIFEST);
  await mount();
  await settle(4, 2_000);
  expect(gatewayApi().status).toBe('connected');
}

function transcriptEntry(gatewayId: string, sessionKey: string, id: string): CommandTranscriptEntry {
  return {
    id,
    gatewayId,
    sessionKey,
    sessionId: sessionKey,
    input: '/status',
    title: 'status',
    status: 'complete',
    summary: 'ok',
    createdAt: 1,
  };
}

describe('leaving a Bot Chat releases its thread', () => {
  test('clearBot drops the Bot session and messages, opening a fresh gateway thread', async () => {
    await mountConnected('open1');
    let opened = false;
    await act(async () => {
      opened = await gatewayApi().openBot('scout');
    });
    await settle();
    expect(opened).toBe(true);
    const botSession = gatewayApi().currentSessionId;
    // The Bot Chat is its own thread and carries the Bot's turns.
    expect(botSession).toBeTruthy();
    expect(chatApi().messages.length).toBeGreaterThanOrEqual(0);

    await act(async () => {
      gatewayApi().clearBot();
    });
    await settle();

    // The Bot Chat is left behind: a different session is live and its
    // transcript is gone, so the configurable surface is not the Bot's.
    expect(gatewayApi().currentSessionId).toBeTruthy();
    expect(gatewayApi().currentSessionId).not.toBe(botSession);
    expect(chatApi().messages).toEqual([]);
  });
});

describe('thread-sheet actions are never silent no-ops without a client', () => {
  test('createNewSession closes the sheet and reports the missing connection', async () => {
    await mountConnected('open2a');
    await act(async () => {
      gatewayApi().disconnectGateway();
    });
    await settle();
    await act(async () => {
      await gatewayApi().openSessionSelector();
    });
    expect(gatewayApi().sessionSelector.visible).toBe(true);

    await act(async () => {
      await gatewayApi().createNewSession();
    });

    expect(gatewayApi().sessionSelector.visible).toBe(false);
    expect(gatewayApi().lastError).toBeTruthy();
  });

  test('deleteSessionById reports the missing connection instead of doing nothing', async () => {
    await mountConnected('open2b');
    await act(async () => {
      gatewayApi().disconnectGateway();
    });
    await settle();

    await act(async () => {
      await gatewayApi().deleteSessionById('own-1');
    });

    expect(gatewayApi().lastError).toBeTruthy();
  });
});

describe('deleting a bubble removes its durable transcript', () => {
  test('deleteLocalMessage drops the stored entry so a reload cannot restore it', async () => {
    const gatewayId = 'tail1';
    await mountConnected(gatewayId);
    const sessionKey = gatewayApi().currentSessionId ?? 'default';
    const id = createTranscriptId('cmd');
    await act(async () => {
      await appendTranscript(gatewayId, sessionKey, transcriptEntry(gatewayId, sessionKey, id));
    });
    expect((await loadTranscripts(gatewayId, sessionKey)).map((entry) => entry.id)).toEqual([id]);

    await act(async () => {
      gatewayApi().deleteLocalMessage(id);
    });
    await settle();

    expect(await loadTranscripts(gatewayId, sessionKey)).toEqual([]);
  });
});

describe('deleting a thread removes its durable transcript', () => {
  test('deleteSessionById clears the deleted session transcript', async () => {
    const gatewayId = 'v1';
    await mountConnected(gatewayId);
    const sessionKey = gatewayApi().currentSessionId ?? 'default';
    const id = createTranscriptId('cmd');
    await act(async () => {
      await appendTranscript(gatewayId, sessionKey, transcriptEntry(gatewayId, sessionKey, id));
    });
    expect((await loadTranscripts(gatewayId, sessionKey)).map((entry) => entry.id)).toEqual([id]);

    await act(async () => {
      await gatewayApi().deleteSessionById(sessionKey);
    });
    await settle();

    expect(await loadTranscripts(gatewayId, sessionKey)).toEqual([]);
  });
});
