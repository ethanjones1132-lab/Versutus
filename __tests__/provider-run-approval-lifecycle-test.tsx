import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { AppState, type AppStateStatus } from 'react-native';

import {
  GatewayProvider,
  useGateway,
  type GatewayContextValue,
} from '@/context/gateway-provider';
import type { ConnectionStatus, GatewayProfile, HermesSession, SessionMessage } from '@/lib/gateway/types';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';
import type { GatewayManifest } from '@/lib/portal/manifest';

// One Activity row, one stop. `stopActivityRun` aborts the run driver this
// phone is holding AND asks the Gate to stop the row it names — so the two
// halves of "stop" only agree while the named row IS the driven run. Two runs
// can be live at once (a durable-outbox `/run` flush alongside a `/run` from
// Runs), and while both are, tapping Stop on the wrong card killed the run the
// operator was watching.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

const mockState = {
  gateways: [] as GatewayProfile[],
  activeId: null as string | null,
  settings: { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' },
  manifests: new Map<string, GatewayManifest | null>(),
  history: [] as SessionMessage[],
  /** True models a Gate whose stopRun never answers, so its driver stays unwinding. */
  stopRunHangs: false,
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

jest.mock('@/lib/gateway/transcript', () => ({
  ...jest.requireActual('@/lib/gateway/transcript'),
  flushTranscripts: jest.fn(async () => undefined),
}));

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

type FakeClient = PortalClient & {
  callbacks: PortalClientCallbacks;
  /** Every run id Stop was asked to stop at the Gate, in order. */
  stops: string[];
  /** The event stream each run is driving, by run id. */
  streams: Map<string, AbortSignal | undefined>;
  /** Every decision the driver sent back to the run, in order. */
  resolutions: { runId: string; approved: boolean }[];
};

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function mockMakeClient(callbacks: PortalClientCallbacks): FakeClient {
  let sessionId: string | undefined;
  let connectionStatus: ConnectionStatus = 'disconnected';
  const client = {
    callbacks,
    stops: [] as string[],
    streams: new Map<string, AbortSignal | undefined>(),
    resolutions: [] as { runId: string; approved: boolean }[],
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
    streamChat: async () => 'pong',
    cancelTurn: async () => undefined,
    getModels: async () => [{ id: 'm1', object: 'model' }],
    getCapabilities: async () => ({ chat: true, models: true }),
    getSessions: async () => [SESSION],
    createSession: async () => SESSION,
    getSessionMessages: async () => mockState.history,
    setBotId: () => undefined,
    setBackendId: () => undefined,
    suspendReconnect: () => undefined,
    resumeReconnect: () => undefined,
    startRun: async (prompt: string) => ({ run_id: `run-${prompt}` }),
    // A run that asks for approval until the operator's decision reaches the
    // Gate, then goes back to working. That is the shape the approval card is
    // raised against, and the shape the stop paths have to end it.
    getRunStatus: async () => ({
      status: client.resolutions.length > 0 ? 'running' : 'waiting-approval',
    }),
    streamRunEvents: async (runId: string, _onEvent: (event: never) => void, signal?: AbortSignal) => {
      client.streams.set(runId, signal);
      return new Promise<void>((_resolve, reject) => {
        if (!signal) return;
        if (signal.aborted) {
          reject(abortError());
          return;
        }
        signal.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    },
    resolveApproval: async (runId: string, approved: boolean) => {
      client.resolutions.push({ runId, approved });
    },
    stopRun: async (runId: string) => {
      client.stops.push(runId);
      if (mockState.stopRunHangs) {
        await new Promise<void>(() => undefined);
      }
    },
  };
  return client as unknown as FakeClient;
}

const mockClients: FakeClient[] = [];

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

/** Start a run without awaiting it — the run stays on screen. */
async function startRun(prompt: string): Promise<void> {
  await act(async () => {
    void gatewayApi().runTask(prompt).catch(() => undefined);
  });
  await settle();
}

/** The live Activity row for a prompt, by the prompt the run was started with. */
function row(prompt: string) {
  return gatewayApi().activityRuns.find((run) => run.prompt === prompt);
}

beforeEach(() => {
  jest.useFakeTimers();
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.settings = { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' };
  mockState.manifests = new Map();
  mockState.history = [];
  mockState.stopRunHangs = false;
  mockClients.length = 0;
  appStateListeners = [];
  observed.gateway = null;
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

// A run's approval card is on five surfaces at once (chat, Activity, Home, the
// fleet constellation and the lock-screen action) and every one of them reads
// `pendingRunApproval`. Nothing but `resolveRunApproval` ever cleared it, so
// every exit that ends the run — Stop, Stop run, Cancel, a disconnect, a
// deleted profile — left a card up naming a run that could no longer be
// approved, with the Activity row beside it reading `cancelled`.
describe('PROV-2 / PROV-11: the approval card ends with the run it names', () => {
  beforeEach(() => {
    const staged = profile({ id: 'alpha', url: 'http://alpha.test:8642' });
    mockState.gateways = [staged];
    mockState.activeId = staged.id;
  });

  /** A run parked on the approval the Gate asked for. */
  async function runIntoApproval(): Promise<string> {
    await mount();
    await startRun('sweep the garage');
    expect(gatewayApi().pendingRunApproval?.runId).toBe('run-sweep the garage');
    expect(row('sweep the garage')!.status).toBe('waiting-approval');
    return row('sweep the garage')!.id;
  }

  test('Stop run takes the card down with the run it names', async () => {
    const runId = await runIntoApproval();

    await act(async () => {
      gatewayApi().stopActivityRun(runId);
    });
    await settle();

    expect(row('sweep the garage')!.status).toBe('cancelled');
    expect(gatewayApi().pendingRunApproval).toBeNull();
  });

  test('Approve on a card whose run is gone approves nothing anywhere', async () => {
    const runId = await runIntoApproval();
    await act(async () => {
      gatewayApi().stopActivityRun(runId);
    });
    await settle();

    // The operator taps Approve on the card the stop left behind. Nothing is
    // approved anywhere; the card only vanishes.
    await act(async () => {
      gatewayApi().resolveRunApproval(true);
    });
    await settle();

    expect(gatewayApi().pendingRunApproval).toBeNull();
    expect(mockClients[0].resolutions.every((entry) => !entry.approved)).toBe(true);
  });

  test('Disconnect takes the card down, and with it the run still polling the discarded client', async () => {
    await runIntoApproval();

    await act(async () => {
      gatewayApi().disconnectGateway();
    });
    await settle();

    expect(gatewayApi().pendingRunApproval).toBeNull();
    // The driver was parked on the approval, so the abort is what reached it:
    // the promise resolved as denied and the run settled as the operator's stop.
    expect(mockClients[0].resolutions).toEqual([{ runId: 'run-sweep the garage', approved: false }]);
    expect(row('sweep the garage')!.status).toBe('cancelled');
  });

  test('a live run the phone is streaming is aborted by a Disconnect too', async () => {
    await mount();
    await act(async () => {
      void gatewayApi().runTask('sweep the garage').catch(() => undefined);
    });
    // Approve, so the run goes back to working and streams events.
    await settle(2, 1);
    await act(async () => {
      gatewayApi().resolveRunApproval(true);
    });
    await settle();
    expect(mockClients[0].streams.get('run-sweep the garage')).toBeDefined();

    await act(async () => {
      gatewayApi().disconnectGateway();
    });
    await settle();

    expect(mockClients[0].streams.get('run-sweep the garage')?.aborted).toBe(true);
    expect(row('sweep the garage')!.status).not.toBe('running');
  });

  test('deleting the profile the run belongs to takes the card down as well', async () => {
    await runIntoApproval();

    await act(async () => {
      await gatewayApi().deleteGateway('alpha');
    });
    await settle();

    expect(gatewayApi().pendingRunApproval).toBeNull();
    expect(mockClients[0].resolutions).toEqual([{ runId: 'run-sweep the garage', approved: false }]);
    expect(row('sweep the garage')!.status).toBe('cancelled');
  });
});

