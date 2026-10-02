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
import { keyValueStorage } from '@/lib/storage/key-value';

// Deleting a gateway cascades into four stores (transcripts, session labels,
// the cached pages and the last-seen stamps). They were awaited as four
// sequential unguarded batches in front of every teardown statement, and
// `clearTranscriptsForGateway` is the only one of the four whose store calls
// can reject — so one corrupt key skipped the other three clears, the client
// pin, `setActiveGateway(null)` and `saveActiveGatewayId(null)`: the profile
// was gone from the roster while the dashboard reported the delete as failed
// and the app kept it as the active gateway. These pin that a refused store
// cannot skip the teardown, and that a delete whose stores all answer is
// unchanged.

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
  /** True models a read that fails for any reason that is not the Gate saying no. */
  approvalsRefuse: false,
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
  /** Every approval id a decision was sent for, in order. */
  approvalsDecided: string[];
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
    /** Every approval id a decision was sent for, in order. */
    approvalsDecided: [] as string[],
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
    rpcRequest: async (method: string, params?: Record<string, unknown>) => {
      if (method === 'approval.approve' || method === 'approval.deny') {
        client.approvalsDecided.push(String((params as { approvalId?: string }).approvalId ?? ''));
        return {};
      }
      if (method !== 'approvals.pending') return {};
      if (mockState.approvalsRefuse) throw new Error('Gate is busy');
      return {
        approvals: [
          { id: 'approval-1', botId: 'scout', class: 'write', summary: 'Read the garage' },
          { id: 'approval-2', botId: null, class: 'destructive', summary: 'Delete the garage log' },
        ],
      };
    },
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

beforeEach(() => {
  jest.useFakeTimers();
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.settings = { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' };
  mockState.manifests = new Map();
  mockState.history = [];
  mockState.stopRunHangs = false;
  mockState.approvalsRefuse = false;
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

// A failed read of the approvals inbox says nothing about what the Gate is still
// holding. The Gate serves one request at a time, a relayed link blips, and a
// read can land after the socket closed — none of which is the Gate cancelling
// anything. Emptying the rows on any of them threw away the approval the
// operator was halfway through deciding, and nothing restored it except the next
// `connected` transition, which a link that stays nominally connected never fires.

// Deleting a profile tidies four stores before it tears anything down. Only the
// transcript clear is unguarded — `clearCachedForGateway` and `clearLastSeen`
// catch their own store calls and `clearSessionLabelsForGateway` is built from a
// pair that does — so a refusal there used to abandon the other three AND every
// statement after them: `clientRef.current = null`, `setActiveGateway(null)`,
// `saveActiveGatewayId(null)` and the auto-connect handover. The profile was
// already out of the roster, so the dashboard reported "the profile is still
// saved" for a delete that had removed it, and the app kept showing it as the
// active gateway with its session pinned.
describe('PROV-9: one refusing store cannot skip the delete teardown', () => {
  beforeEach(() => {
    const staged = profile({ id: 'alpha', url: 'http://alpha.test:8642' });
    mockState.gateways = [staged];
    mockState.activeId = staged.id;
  });

  test('the active gateway is torn down even when the transcript clear refuses', async () => {
    jest.spyOn(keyValueStorage, 'getAllKeys').mockRejectedValue(new Error('store refused'));
    await mount();
    expect(gatewayApi().activeGateway?.id).toBe('alpha');

    await act(async () => {
      await gatewayApi().deleteGateway('alpha');
    });
    await settle();

    // The teardown ran.
    expect(gatewayApi().activeGateway).toBeNull();
    expect(mockState.activeId).toBeNull();
    expect(mockState.gateways).toEqual([]);
    // And the promise resolved, so the sheet closes instead of reporting a
    // delete that did happen as one that did not.
  });

  test('the remaining three clears still run after the refusal', async () => {
    jest.spyOn(keyValueStorage, 'getAllKeys').mockRejectedValue(new Error('store refused'));
    const removed = jest.spyOn(keyValueStorage, 'removeItem');
    await mount();

    await act(async () => {
      await gatewayApi().deleteGateway('alpha');
    });
    await settle();

    // The last-seen stamp rides `removeItem` directly, so it is the proof the
    // later clears were not abandoned behind the first one.
    expect(removed).toHaveBeenCalledWith('versutus:last-seen:alpha');
  });

  test('a delete whose stores all answer is unchanged', async () => {
    await mount();

    await act(async () => {
      await gatewayApi().deleteGateway('alpha');
    });
    await settle();

    expect(gatewayApi().activeGateway).toBeNull();
    expect(mockState.activeId).toBeNull();
  });
});
