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
import { gateManifestCacheKey, saveCachedGateManifest } from '@/lib/portal/attach-manifest';
import { saveWorkflows } from '@/lib/gateway/workflows';
import { keyValueStorage } from '@/lib/storage/key-value';
import { removeGatewayIds } from '@/lib/gateway/storage';
import type { ConnectionStatus, GatewayProfile, HermesSession } from '@/lib/gateway/types';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';
import type { GatewayManifest } from '@/lib/portal/manifest';

// SPD-1/SPD-4: a cold connect read the same facts more than once, and every
// transition to `connected` fired the whole set together against a
// single-threaded Gate while the transcript the operator is waiting for was
// still in flight. The client is the seam; the provider's own scheduling is the
// observation.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

const mockState = {
  gateways: [] as GatewayProfile[],
  activeId: null as string | null,
  settings: { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' },
  manifests: new Map<string, GatewayManifest | null>(),
  /** Every well-known URL the provider asked for, in order. */
  manifestFetches: [] as string[],
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
      mockState.manifestFetches.push(url);
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
  endpoints: {
    health: '/health',
    models: '/v1/models',
    chat: '/v1/chat/completions',
    capabilitiesRpc: '/v1/capabilities/rpc',
  },
  auth: { schemes: ['bearer'] },
} as unknown as GatewayManifest;

/** The same Gate, answered from a host it has since moved to. */
const MOVED_GATE_MANIFEST = {
  ...GATE_MANIFEST,
  name: 'Versutus Gate (moved)',
} as unknown as GatewayManifest;

const HISTORY = [
  { id: 'm1', role: 'user', content: 'ping', timestamp: 1 },
  { id: 'm2', role: 'assistant', content: 'pong', timestamp: 2 },
];

const HELLO = { type: 'hello-ok', protocol: 1, server: { version: '0.18.0' } };
const SESSION = { id: 'live-session', title: 'Live', createdAt: 0 } as unknown as HermesSession;
const HEALTHY = { status: 'ok' };

const CRON_JOB = {
  id: 'job-sweep',
  title: 'Minute sweep',
  name: '[bot:scout] Minute sweep',
  schedule: '0 9 * * *',
  nextRunAt: '2999-01-01T09:00:00.000Z',
};

const ROSTER = [{ id: 'scout', displayName: 'Scout' }];

type ConnectScript = (callbacks: PortalClientCallbacks, setStatus: (next: ConnectionStatus) => void) => Promise<void>;

const CONNECT_OK: ConnectScript = async (callbacks, setStatus) => {
  setStatus('connecting');
  callbacks.onStatus?.('connecting', 'Connecting…');
  setStatus('connected');
  callbacks.onStatus?.('connected');
  callbacks.onHello?.(HELLO);
  callbacks.onHealthCheck?.(true, HEALTHY as never);
};

let connectScript: ConnectScript = CONNECT_OK;
const mockClients: FakeClient[] = [];
/** Whether the built client advertises the cron seam at all. */
let cronAvailable = true;
/** Whether the gateway answers a probe. False models a gateway that is not up. */
let mockProbeOk = true;

type FakeClient = PortalClient & {
  rpcMethods: string[];
  getModelsCalls: number;
  listCronJobsCalls: number;
  listBotsCalls: number;
  listJobsCalls: number;
};

function mockMakeClient(callbacks: PortalClientCallbacks): FakeClient {
  let sessionId: string | undefined;
  const client = {
    connectionStatus: 'disconnected' as ConnectionStatus,
    statusDetail: '',
    authRejected: false,
    botId: undefined,
    canManageSessions: true,
    rpcMethods: [] as string[],
    getModelsCalls: 0,
    listCronJobsCalls: 0,
    listBotsCalls: 0,
    listJobsCalls: 0,
    ...(cronAvailable
      ? {
          listCronJobs: async () => {
            client.listCronJobsCalls += 1;
            return [CRON_JOB];
          },
        }
      : {}),
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
    healthCheck: async () => HEALTHY,
    rpcRequest: async (method: string) => {
      client.rpcMethods.push(method);
      return { data: [] };
    },
    streamChat: async () => 'pong',
    getModels: async () => {
      client.getModelsCalls += 1;
      if (modelsAnswer) return modelsAnswer();
      return [{ id: 'm1', object: 'model' }];
    },
    getCapabilities: async () => ({ chat: true, models: true }),
    getSessions: async () => [SESSION],
    createSession: async () => SESSION,
    getSessionMessages: async () => HISTORY,
    stopRun: async () => undefined,
    setBotId: () => undefined,
    setBackendId: () => undefined,
    suspendReconnect: () => undefined,
    resumeReconnect: () => undefined,
    forceReconnect: () => {
      client.connectionStatus = 'reconnecting';
      callbacks.onStatus?.('reconnecting', 'Checking the connection');
    },
    listBots: async () => {
      client.listBotsCalls += 1;
      return ROSTER;
    },
    listJobs: async () => {
      client.listJobsCalls += 1;
      return [{ id: CRON_JOB.id, name: CRON_JOB.name, schedule: CRON_JOB.schedule }];
    },
  };
  return client as unknown as FakeClient;
}

/** What `getModels` answers; a promise that never settles stalls the whole point. */
let modelsAnswer: (() => Promise<unknown[]>) | null = null;

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

function approvalsReads(client: FakeClient): number {
  return client.rpcMethods.filter((method) => method === 'approvals.pending').length;
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

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
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
  // Enough for the connect to land, and nothing more: the connected-time reads
  // this file is about are all further out than this.
  await settle(6, 0);
}

beforeEach(async () => {
  // The gate-manifest cache is this device's real key-value storage, and one
  // of these tests writes to it: a test that means to exercise the LIVE path
  // must not inherit a cached document and quietly take the cached one instead.
  await keyValueStorage.removeItem(gateManifestCacheKey('alpha'));
  jest.useFakeTimers();
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.settings = { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' };
  mockState.manifests = new Map();
  mockState.manifestFetches = [];
  mockClients.length = 0;
  connectScript = CONNECT_OK;
  cronAvailable = true;
  mockProbeOk = true;
  modelsAnswer = null;
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

describe('one manifest read per connect', () => {
  test('a live-served manifest is not fetched again after connect', async () => {
    const alpha = profile({ id: 'alpha', url: 'http://alpha.test:8642', kind: 'custom' });
    mockState.gateways = [alpha];
    mockState.activeId = alpha.id;
    mockState.manifests.set(alpha.url, GATE_MANIFEST);

    await mount();
    await settle(4, 2_000);

    expect(gatewayApi().status).toBe('connected');
    // The document the client was built from, read once.
    expect(mockState.manifestFetches).toEqual([alpha.url]);
    expect(gatewayApi().activeManifest?.name).toBe('Versutus Gate');
  });

  test('a cached manifest refreshes in the background and is published when it lands', async () => {
    const alpha = profile({ id: 'alpha', url: 'http://alpha.test:8642', kind: 'custom' });
    mockState.gateways = [alpha];
    mockState.activeId = alpha.id;
    mockState.manifests.set(alpha.url, MOVED_GATE_MANIFEST);
    await saveCachedGateManifest(alpha.id, GATE_MANIFEST);

    await mount();
    await settle(4, 2_000);

    expect(gatewayApi().status).toBe('connected');
    // The refresh inside the attach is the only read: the attach did not queue
    // a second one behind it.
    expect(mockState.manifestFetches).toEqual([alpha.url]);
    expect(gatewayApi().activeManifest?.name).toBe('Versutus Gate (moved)');
  });

  test('the connect does not wait on a model catalogue read for its default pin', async () => {
    const alpha = profile({ id: 'alpha', url: 'http://alpha.test:8642' });
    modelsAnswer = () => new Promise<unknown[]>(() => undefined);
    await mount();

    let finished = false;
    await act(async () => {
      void gatewayApi().connectGateway(alpha).then(() => {
        finished = true;
      });
      await jest.advanceTimersByTimeAsync(0);
    });

    // `attachClient` used to await this read, so every caller of connectGateway
    // — including the transcript read the operator is watching — sat behind it.
    expect(finished).toBe(true);
    expect(gatewayApi().status).toBe('connected');
  });

  test('a live-served manifest still retires the child profiles it replaces, once', async () => {
    const alpha = profile({ id: 'alpha', url: 'http://alpha.test:8642', kind: 'custom' });
    // A provider child profile from before providers stayed on the parent Gate.
    const legacyChild = profile({
      id: `${alpha.id}::openai`,
      url: `${alpha.url}/p/openai`,
      kind: 'custom',
      parentId: alpha.id,
    });
    mockState.gateways = [alpha, legacyChild];
    mockState.activeId = alpha.id;
    mockState.manifests.set(alpha.url, GATE_MANIFEST);
    jest.mocked(removeGatewayIds).mockClear();

    await mount();
    await settle(4, 2_000);

    // The manifest is not read again after this connect, so the publish that
    // built the client is the only thing that knows what this Gate serves — and
    // the roster that document implies is retired with it, once.
    expect(mockState.manifestFetches).toEqual([alpha.url]);
    expect(jest.mocked(removeGatewayIds).mock.calls).toEqual([[[legacyChild.id]]]);
    expect(gatewayApi().gateways.map((item) => item.id)).toEqual([alpha.id]);
  });
});

describe('the connected-time reads take their turn', () => {
  async function connectAlpha(): Promise<FakeClient> {
    const alpha = profile({ id: 'alpha', url: 'http://alpha.test:8642', kind: 'custom' });
    mockState.gateways = [alpha];
    mockState.activeId = alpha.id;
    mockState.manifests.set(alpha.url, GATE_MANIFEST);
    await mount();
    await settle(4, 2_000);
    return mockClients[0];
  }

  test('approvals land before the routine list, and neither lands first', async () => {
    const client = await connectAlpha();
    expect(approvalsReads(client)).toBe(1);
    expect(client.listCronJobsCalls).toBe(1);
  });

  test('the fan-out is staggered behind the transcript, not fired with it', async () => {
    const alpha = profile({ id: 'alpha', url: 'http://alpha.test:8642', kind: 'custom' });
    mockState.gateways = [alpha];
    mockState.activeId = alpha.id;
    mockState.manifests.set(alpha.url, GATE_MANIFEST);

    await act(async () => {
      renderer = TestRenderer.create(
        <GatewayProvider>
          <Capture />
        </GatewayProvider>,
      );
    });
    await settle(4, 0);
    const client = mockClients[0];

    // Nothing has read anything yet: the transcript is still in flight.
    expect(approvalsReads(client)).toBe(0);
    expect(client.listCronJobsCalls).toBe(0);
    expect(client.listBotsCalls).toBe(0);

    await advance(300);
    expect(approvalsReads(client)).toBe(0);
    expect(client.listCronJobsCalls).toBe(0);

    await advance(400);
    expect(approvalsReads(client)).toBe(1);
    expect(client.listCronJobsCalls).toBe(0);
    expect(client.listBotsCalls).toBe(0);

    await advance(300);
    expect(client.listCronJobsCalls).toBe(1);

    await advance(400);
    expect(client.listBotsCalls).toBe(1);
  });

  test('the routine re-arm reuses the cron read instead of asking the jobs route again', async () => {
    const client = await connectAlpha();
    expect(client.listCronJobsCalls).toBe(1);
    // The two reads name the same facts through different routes; asking twice
    // on one connect is the duplicate this removes.
    expect(client.listJobsCalls).toBe(0);
  });

  test('the routine re-arm still asks the jobs route when the cron read never landed', async () => {
    // A gateway with no cron seam at all: the widget read cannot run, so the
    // re-arm has to read for itself or notices go unarmed.
    cronAvailable = false;
    const alpha = profile({ id: 'alpha', url: 'http://alpha.test:8642', kind: 'custom' });
    mockState.gateways = [alpha];
    mockState.activeId = alpha.id;
    mockState.manifests.set(alpha.url, GATE_MANIFEST);
    await mount();
    await settle(4, 2_000);

    const client = mockClients[0];
    expect(client.listCronJobsCalls).toBe(0);
    expect(client.listJobsCalls).toBe(1);
  });

  test("the monitor's own recovery inside the window repeats no fan-out", async () => {
    const client = await connectAlpha();
    expect(client.listCronJobsCalls).toBe(1);
    expect(client.listBotsCalls).toBe(1);

    // The monitor recovers in place: the SAME client re-verifies and announces
    // `connected` again, so the generation is unchanged and the facts it just
    // read are still the facts.
    await act(async () => {
      mockClients[0].forceReconnect?.();
    });
    await act(async () => {
      await mockClients[0].connect();
    });
    await settle(4, 2_000);

    expect(client.listCronJobsCalls).toBe(1);
    expect(client.listBotsCalls).toBe(1);
    expect(client.listJobsCalls).toBe(0);
    // An approval nobody has answered still has to appear.
    expect(approvalsReads(client)).toBeGreaterThan(1);
  });

  test('a flap inside the stagger window does not earn the self-heal stamp', async () => {
    const alpha = profile({ id: 'alpha', url: 'http://alpha.test:8642', kind: 'custom' });
    mockState.gateways = [alpha];
    mockState.activeId = alpha.id;
    mockState.manifests.set(alpha.url, GATE_MANIFEST);

    // Connected, with the whole fan-out still queued.
    await mount();
    const client = mockClients[0];

    // The connection drops again inside the stagger window, so every pending
    // timer is cancelled with it: this transition ran no fan-out at all.
    await act(async () => {
      client.forceReconnect?.();
    });
    await act(async () => {
      await client.connect();
    });
    await settle(4, 2_000);

    // A fan-out that never ran has read nothing, so it cannot stand in for the
    // one the recovery is owed — the stamp is written when the set completes.
    expect(client.listCronJobsCalls).toBe(1);
    expect(client.listBotsCalls).toBe(1);
  });

  test('a profile written while connected does not push the workflow read out', async () => {
    const alpha = profile({ id: 'alpha', url: 'http://alpha.test:8642', kind: 'custom' });
    mockState.gateways = [alpha];
    mockState.activeId = alpha.id;
    mockState.manifests.set(alpha.url, GATE_MANIFEST);
    await saveWorkflows(alpha.id, [
      { id: 'wf-1', name: 'Morning sweep', steps: [{ id: 'step-1', prompt: 'Summarise the runs' }] },
    ]);

    await mount();
    // 1s in, the default-model pin writes a brand new profile object (a model
    // the profile did not carry). That is the kind of write that used to
    // restart this read's timer behind it.
    await advance(1_000);
    expect(gatewayApi().activeGateway?.model).toBe('m1');
    // 1.8s: the back of the connected-time queue.
    await advance(800);

    expect(gatewayApi().relatedWorkflows).toHaveLength(1);
  });

  test('a real reconnect of a new client still fans out', async () => {
    const client = await connectAlpha();
    expect(client.listCronJobsCalls).toBe(1);

    await act(async () => {
      await gatewayApi().disconnectGateway();
    });
    await act(async () => {
      await gatewayApi().connectGateway(profile({ id: 'alpha', url: 'http://alpha.test:8642', kind: 'custom' }));
    });
    await settle(4, 2_000);

    expect(mockClients).toHaveLength(2);
    expect(mockClients[1].listCronJobsCalls).toBe(1);
    expect(mockClients[1].listBotsCalls).toBe(1);
    expect(client.listCronJobsCalls).toBe(1);
  });
});