/**
 * R4S-chat1a — the provider's own halves of the chat screen's findings, with the
 * real provider mounted against a fake client.
 *
 * ATTACH-1: the composer's attach control is offered only when the model
 * catalogue DECLARES image input, so a catalogue that is only ever read when the
 * operator opens the model picker hides the paperclip on a vision model until
 * they open a sheet they did not come for.
 *
 * ATTACH-4: an offline-queue row carries the operator's words and nothing else,
 * so parking a turn that has photos in it delivers the sentence and drops the
 * images with nothing anywhere saying so.
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
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadOfflineQueue } from '@/lib/gateway/session-persistence';
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
  manifests: new Map<string, GatewayManifest | null>(),
  /** A manifest fetch that never answers, so an attach can be caught mid-flight. */
  manifestHold: null as Promise<GatewayManifest | null> | null,
  /** What this gateway's `/v1/models` answers. */
  models: [{ id: 'm1', object: 'model' }] as unknown[],
  /** How many times the catalogue has been asked for. */
  modelReads: 0,
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
    getModels: async () => {
      mockState.modelReads += 1;
      return mockState.models;
    },
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

beforeEach(() => {
  jest.useFakeTimers();
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.settings = { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' };
  mockState.manifests = new Map();
  mockState.manifestHold = null;
  mockState.models = [{ id: 'm1', object: 'model' }];
  mockState.modelReads = 0;
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


const VISION_MODEL = { id: 'vision-1', object: 'model', capabilities: ['image', 'text'] };

function visionProfile(): GatewayProfile {
  return profile({ id: 'alpha', url: 'http://alpha.test:8642', model: 'vision-1' });
}

describe('ATTACH-1: the catalogue is read on connect, not only by opening the picker', () => {
  test('a connected gateway has offered its models without the picker ever opening', async () => {
    const alpha = visionProfile();
    mockState.gateways = [alpha];
    mockState.activeId = alpha.id;
    mockState.models = [VISION_MODEL];

    await mount();
    // The background read runs behind the transcript the operator is waiting for.
    await settle(6, 200);

    // Nobody opened the model sheet, and the catalogue is here anyway — which is
    // what the composer's attach gate reads to decide whether a photo can be
    // attached at all.
    expect(gatewayApi().modelPicker.visible).toBe(false);
    expect(gatewayApi().modelCatalog).toContainEqual(VISION_MODEL);
  });

  test('the connect read is not the pickers delivered answer, and the picker still reads', async () => {
    const alpha = visionProfile();
    mockState.gateways = [alpha];
    mockState.activeId = alpha.id;
    await mount();
    await settle(6, 200);
    const afterConnect = mockState.modelReads;
    expect(afterConnect).toBeGreaterThan(0);

    // The connect read filled the catalogue behind the sheet, so it must not also
    // claim the sheet has heard from the gateway: its loading copy and its
    // refusal line stay honest until it reads for itself.
    expect(gatewayApi().modelCatalogLoaded).toBe(false);

    await act(async () => {
      await gatewayApi().openModelPicker('default');
    });
    await settle();

    expect(mockState.modelReads).toBeGreaterThan(afterConnect);
    expect(gatewayApi().modelPicker.visible).toBe(true);
    expect(gatewayApi().modelCatalogLoaded).toBe(true);
  });
});

describe('ATTACH-4: photos are never parked in the offline outbox', () => {
  const PHOTO = { kind: 'image' as const, uri: 'data:image/jpeg;base64,QUJD', mimeType: 'image/jpeg' };

  // The outbox is durable, so each case starts from a device that owes nothing.
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  test('a turn with photos is refused, not queued as a sentence with no images', async () => {
    // No gateway at all: the phone is offline, which is the branch that parks.
    await mount();

    let outcome = '';
    await act(async () => {
      outcome = await gatewayApi().sendChatInput('what is this?', { attachments: [PHOTO] });
    });

    // The queue row has no attachment field, so parking it would send the words
    // and lose the pictures with nothing saying so.
    expect(outcome).toBe('offline');
    expect(await loadOfflineQueue()).toEqual([]);
  });

  test('a text-only turn is still parked, exactly as before', async () => {
    await mount();

    let outcome = '';
    await act(async () => {
      outcome = await gatewayApi().sendChatInput('on my way');
    });

    expect(outcome).toBe('queued');
    const queued = await loadOfflineQueue();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ text: 'on my way' });
  });
});
