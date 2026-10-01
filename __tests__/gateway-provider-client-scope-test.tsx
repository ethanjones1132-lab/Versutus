import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import {
  GatewayProvider,
  useChatSurface,
  useGateway,
  type ChatSurfaceContextValue,
  type GatewayContextValue,
} from '@/context/gateway-provider';
import { gateManifestCacheKey } from '@/lib/portal/attach-manifest';
import { keyValueStorage } from '@/lib/storage/key-value';
import type { ConnectionStatus, GatewayProfile, HermesSession } from '@/lib/gateway/types';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';
import type { GatewayManifest } from '@/lib/portal/manifest';

// 2026-10-01, phone screenshots: in a thread on `hermes-local` every turn came
// back with the GATE's provider errors — `Unknown provider "kilo"` for
// `kilo/kilo-auto/free`, `Unknown provider "opencode-go-session"` for the Go
// session model — while `opencode-go/deepseek-v4.1-flash` (a provider record the
// Gate itself owns) reached that vendor and was refused. Every rebuild of the
// client dropped the thread's environment and Bot: `selectedBackendId` /
// `selectedBotId` live in provider state and survive, the client's own scope
// does not, and nothing put it back. So the thread the UI showed and the turn
// the wire carried were two different conversations.

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
   * What each manifest fetch answers, in order, when a test needs the document
   * to arrive late. `hold` parks a fetch until `releaseManifestAnswer` answers
   * it, which is how the post-connect fetch is caught in flight.
   */
  manifestAnswers: [] as (GatewayManifest | null | 'hold')[],
  releaseManifestAnswer: null as (() => void) | null,
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
      const answer = mockState.manifestAnswers.shift();
      if (answer === 'hold') {
        return new Promise<GatewayManifest | null>((resolve) => {
          mockState.releaseManifestAnswer = () => resolve(mockState.manifests.get(url) ?? null);
        });
      }
      return answer ?? mockState.manifests.get(url) ?? null;
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

/** A Gate fronting one Hermes environment, as the operator's Gate does. */
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
    },
    auth: { schemes: ['bearer'] },
    backends: BACKENDS,
  } as unknown as GatewayManifest;
}

const GATE_MANIFEST = gateManifest('Versutus Gate');
const OTHER_GATE_MANIFEST = gateManifest('Other Gate');

const HELLO = { type: 'hello-ok', protocol: 1, server: { version: '0.18.0' } };
const SESSION = { id: 'live-session', title: 'Live', createdAt: 0 } as unknown as HermesSession;
const HEALTHY = { status: 'ok' };
const ROSTER = [{ id: 'scout', displayName: 'Scout' }];

/** One recorded scope write or turn, tagged with the client it happened on. */
let events: string[] = [];

type FakeClient = PortalClient & {
  /** Which built client this is, 1-based, so an event can name it. */
  readonly label: string;
  /** Every scope setter call, in order, exactly as it was given. */
  scopeCalls: { backendId?: string; botId?: string }[];
  /**
   * What a turn would have put on the wire — the decision `streamChat` makes
   * from its own scope, so an unscoped client shows up here as the provider id
   * it fell back to.
   */
  sends: { backendId?: string; bot?: string; providerId?: string }[];};

function mockMakeClient(callbacks: PortalClientCallbacks): FakeClient {
  let sessionId: string | undefined;
  let backendId: string | undefined;
  let botId: string | undefined;
  const label = `client${mockClients.length + 1}`;
  const client = {
    label,
    scopeCalls: [] as { backendId?: string; botId?: string }[],
    sends: [] as { backendId?: string; bot?: string; providerId?: string }[],
    connectionStatus: 'disconnected' as ConnectionStatus,
    statusDetail: '',
    authRejected: false,
    canManageSessions: true,
    connect: async () => {
      events.push(`${label}:connect`);
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
    streamChat: async (
      _messages: unknown,
      _onDelta: (text: string) => void,
      options?: { providerId?: string },
    ) => {
      events.push(`${label}:streamChat`);
      // The real client's own rule: a Bot names its environment and the backend
      // stays off the body; without either, a scoped client falls back to the
      // provider id the picked model came from — the operator's failing turn.
      client.sends.push(
        botId
          ? { backendId: undefined, bot: botId, providerId: undefined }
          : backendId
            ? { backendId, bot: undefined, providerId: undefined }
            : { providerId: options?.providerId },
      );
      return 'pong';
    },
    getModels: async () => [{ id: 'kilo/kilo-auto/free', object: 'model' }],
    getCapabilities: async () => ({ chat: true, models: true }),
    getSessions: async () => [SESSION],
    createSession: async () => SESSION,
    getSessionMessages: async () => [],
    stopRun: async () => undefined,
    setBotId: (id: string | undefined) => {
      botId = id || undefined;
      events.push(`${label}:setBotId:${botId ?? 'none'}`);
      client.scopeCalls.push({ botId });
    },
    setBackendId: (id: string | undefined) => {
      backendId = id;
      events.push(`${label}:setBackendId:${id ?? 'none'}`);
      client.scopeCalls.push({ backendId: id });
    },
    suspendReconnect: () => undefined,
    resumeReconnect: () => undefined,
    listBots: async () => ROSTER,
  };
  return client as unknown as FakeClient;
}

const mockClients: FakeClient[] = [];

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
  // The gate-manifest cache is this device's real storage; a document left by
  // another test would make a connect read one this test never served.
  await keyValueStorage.removeItem(gateManifestCacheKey('alpha'));
  await keyValueStorage.removeItem(gateManifestCacheKey('beta'));
  jest.useFakeTimers();
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.settings = { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' };
  mockState.manifests = new Map();
  mockState.manifestAnswers = [];
  mockState.releaseManifestAnswer = null;
  mockClients.length = 0;
  events = [];
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

/** A connected Gate whose thread has already adopted its environment. */
async function mountAdoptedHermes(): Promise<void> {
  const alpha = profile({
    id: 'alpha',
    url: 'http://alpha.test:8642',
    backendId: 'hermes-local',
    // The pick the operator made on this thread: a model only Hermes serves,
    // named by the provider that owns it on the environment.
    model: 'kilo/kilo-auto/free',
    providerId: 'kilo',
  });
  mockState.gateways = [alpha];
  mockState.activeId = alpha.id;
  mockState.manifests.set(alpha.url, GATE_MANIFEST);
  await mount();
  await settle(4, 2_000);
  expect(gatewayApi().status).toBe('connected');
  await act(async () => {
    gatewayApi().selectBackend('hermes-local');
  });
  await settle();
  expect(gatewayApi().selectedBackendId).toBe('hermes-local');
}

/** A dropped connection and a fresh attach of the same gateway. */
async function reattachAlpha(): Promise<void> {
  await act(async () => {
    gatewayApi().disconnectGateway();
  });
  await act(async () => {
    await gatewayApi().connectGateway(gatewayApi().gateways[0]);
  });
  await settle(4, 2_000);
}

describe('a rebuilt client keeps the thread it was showing', () => {
  test('a re-attach of the same gateway hands the environment to the new client', async () => {
    await mountAdoptedHermes();
    expect(mockClients).toHaveLength(1);

    await reattachAlpha();

    // A new client, and it is the one every turn now goes through.
    expect(mockClients).toHaveLength(2);
    const rebuilt = mockClients[1];
    expect(rebuilt.scopeCalls).toContainEqual({ backendId: 'hermes-local' });

    await act(async () => {
      await gatewayApi().sendChatInput('ping');
    });
    await settle();

    // The scope rides the install, so it is in place before anything can send.
    expect(events.indexOf('client2:setBackendId:hermes-local')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('client2:setBackendId:hermes-local')).toBeLessThan(
      events.indexOf('client2:streamChat'),
    );
  });

  test('the turn the rebuilt client sends names the environment, not a provider', async () => {
    await mountAdoptedHermes();
    await reattachAlpha();

    await act(async () => {
      await gatewayApi().sendChatInput('ping');
    });
    await settle();

    // The operator's failing turn: a scope-less client fell back to
    // `providerId: 'kilo'` — a provider the Gate does not own. The thread is on
    // hermes-local, so that is what the turn names instead.
    expect(mockClients[1].sends).toEqual([{ backendId: 'hermes-local', bot: undefined, providerId: undefined }]);
  });

  test('a re-attach of a Bot thread hands the Bot to the new client', async () => {
    await mountAdoptedHermes();
    let opened = false;
    await act(async () => {
      opened = await gatewayApi().openBot('scout');
    });
    await settle();
    expect(opened).toBe(true);
    expect(gatewayApi().selectedBotId).toBe('scout');

    await reattachAlpha();

    const rebuilt = mockClients[1];
    expect(rebuilt.scopeCalls).toContainEqual({ botId: 'scout' });

    await act(async () => {
      await gatewayApi().sendChatInput('ping');
    });
    await settle();

    expect(events.indexOf('client2:setBotId:scout')).toBeLessThan(events.indexOf('client2:streamChat'));
    // A Bot names its own environment, so the turn names the Bot and no backend.
    expect(mockClients[1].sends).toEqual([{ backendId: undefined, bot: 'scout', providerId: undefined }]);
  });

  test('a late manifest that upgrades the client hands it the same scope', async () => {
    // The upgrade path is the one the field reports: the phone connected through
    // the Hermes adapter because the well-known fetch missed, the Gate answered
    // a moment later, and the client was rebuilt as the Gate's own — with nothing
    // to say which environment the thread on screen belonged to.
    const alpha = profile({
      id: 'alpha',
      url: 'http://alpha.test:8642',
      backendId: 'hermes-local',
      model: 'kilo/kilo-auto/free',
      providerId: 'kilo',
    });
    mockState.gateways = [alpha];
    mockState.activeId = alpha.id;
    // Both attach-time fetches miss, and the post-connect one is parked so the
    // document lands while the thread is already on hermes-local.
    mockState.manifestAnswers = [null, null, 'hold'];
    await mount();
    await settle(4, 2_000);
    expect(mockClients).toHaveLength(1);
    await act(async () => {
      gatewayApi().selectBackend('hermes-local');
    });
    await settle();
    expect(gatewayApi().selectedBackendId).toBe('hermes-local');

    mockState.manifests.set(alpha.url, GATE_MANIFEST);
    await act(async () => {
      mockState.releaseManifestAnswer?.();
      await settle(8, 2_000);
    });

    expect(mockClients).toHaveLength(2);
    expect(gatewayApi().activeManifest?.name).toBe('Versutus Gate');
    expect(mockClients[1].scopeCalls).toContainEqual({ backendId: 'hermes-local' });
    expect(events.indexOf('client2:setBackendId:hermes-local')).toBeLessThan(
      events.indexOf('client2:connect'),
    );

    await act(async () => {
      await gatewayApi().sendChatInput('ping');
    });
    await settle();
    expect(mockClients[1].sends).toEqual([{ backendId: 'hermes-local', bot: undefined, providerId: undefined }]);
  });
});

describe('a different gateway starts from its own scope', () => {
  test("gateway A's environment and Bot are not carried onto gateway B's client", async () => {
    await mountAdoptedHermes();
    await act(async () => {
      await gatewayApi().openBot('scout');
    });
    await settle();
    expect(gatewayApi().selectedBotId).toBe('scout');

    const beta = profile({ id: 'beta', url: 'http://beta.test:8642', token: 'token-2', backendId: 'hermes-local' });
    mockState.gateways = [...mockState.gateways, beta];
    mockState.manifests.set(beta.url, OTHER_GATE_MANIFEST);
    await act(async () => {
      await gatewayApi().connectGateway(beta);
    });
    await settle(4, 2_000);

    expect(gatewayApi().activeGateway?.id).toBe('beta');
    const onBeta = mockClients[mockClients.length - 1];
    // Neither of A's names survives onto B: B adopts its own default instead.
    expect(onBeta.scopeCalls).not.toContainEqual({ botId: 'scout' });
    expect(onBeta.scopeCalls.filter((call) => call.botId === 'scout')).toHaveLength(0);

    await act(async () => {
      await gatewayApi().sendChatInput('ping');
    });
    await settle();

    // B resolved its own environment from B's manifest (hermes-local here), and
    // no Bot: `openBot` scope belongs to the gateway that was left behind.
    expect(gatewayApi().selectedBotId).toBeUndefined();
    expect(onBeta.sends).toEqual([{ backendId: 'hermes-local', bot: undefined, providerId: undefined }]);
  });
});
