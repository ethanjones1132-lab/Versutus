import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import {
  GatewayProvider,
  useGateway,
  type GatewayContextValue,
  type SendChatInputOutcome,
} from '@/context/gateway-provider';
import { loadOfflineQueue, saveOfflineQueue, type OfflineQueueItem } from '@/lib/gateway/session-persistence';
import type { ConnectionStatus, GatewayProfile, HermesSession, SessionMessage } from '@/lib/gateway/types';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';
import type { GatewayManifest } from '@/lib/portal/manifest';

// VS-096. Stop and a provider-initiated teardown both reject the turn's stream
// with the same abort, so the catch used to treat them as one fact and answer
// 'sent' for both. Stop means the operator ended the turn: the queued row is no
// longer owed. A gateway switch, a Disconnect, a deleted profile or a re-attach
// means the phone left before the Gate had the words: the durable outbox row
// must stay owed, with its turn id, so the next connection retries it instead of
// erasing the operator's line. These drive each provider path through the real
// flush and pin Stop's existing behaviour alongside it.

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

jest.mock('@/lib/gateway/transcript', () => ({
  ...jest.requireActual('@/lib/gateway/transcript'),
  flushTranscripts: jest.fn(async () => undefined),
}));

jest.mock('@/lib/portal/adapters', () => ({
  createClientForKind: jest.fn((kind: string, gateway: GatewayProfile, callbacks: PortalClientCallbacks) => {
    const client = mockMakeClient(callbacks);
    client.id = gateway.id;
    mockClients.push(client);
    return client;
  }),
}));

const HELLO = { type: 'hello-ok', protocol: 1, server: { version: '0.18.0' } };
const SESSION = { id: 'live-session', title: 'Live', createdAt: 0 } as unknown as HermesSession;
const HEALTHY = { status: 'ok' };

const TURN_ID = 'turn-queued-1';

type StreamOptions = NonNullable<Parameters<PortalClient['streamChat']>[2]>;
type StreamScript = (options: StreamOptions, onDelta: (text: string) => void) => Promise<string>;

type FakeClient = PortalClient & {
  id: string;
  /** Every stream this client was asked to run, in order. */
  streams: StreamOptions[];
  disconnects: number;
  /** Make this client report a dropped connection without the provider asking. */
  forceDisconnected: () => void;
};

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/** A stream that never ends on its own — the shape a long turn has on screen. */
function hangUntilAborted(options: StreamOptions): Promise<string> {
  return new Promise<string>((_resolve, reject) => {
    if (!options.signal) return;
    if (options.signal.aborted) {
      reject(abortError());
      return;
    }
    options.signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

function mockMakeClient(callbacks: PortalClientCallbacks): FakeClient {
  let sessionId: string | undefined;
  let connectionStatus: ConnectionStatus = 'disconnected';
  const client = {
    id: '',
    streams: [] as StreamOptions[],
    disconnects: 0,
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
      client.disconnects += 1;
      connectionStatus = 'disconnected';
    },
    forceDisconnected: () => {
      connectionStatus = 'disconnected';
      callbacks.onStatus?.('disconnected');
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
      return (streamScripts.shift() ?? streamScript)(options ?? {}, onDelta);
    },
    cancelTurn: async () => undefined,
    getModels: async () => [{ id: 'm1', object: 'model' }],
    getCapabilities: async () => ({ chat: true, models: true }),
    getSessions: async () => [SESSION],
    createSession: async () => SESSION,
    getSessionMessages: async () => mockState.history,
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

/** Scripts for the next streams, in order, when a turn must not share a script. */
let streamScripts: StreamScript[] = [];

const observed: { gateway: GatewayContextValue | null } = { gateway: null };

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

/** Settle until a condition holds — the outbox read and flush are both async. */
async function waitFor(check: () => boolean, rounds = 80, ms = 5): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    if (check()) return;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }
  throw new Error('the expected condition never held');
}

function profile(id: string, url = `http://${id}.test:8642`): GatewayProfile {
  return { name: id, kind: 'hermes', token: 'token-1', createdAt: 0, id, url } as GatewayProfile;
}

function queuedRow(): OfflineQueueItem {
  return { id: 'queued-1', text: 'on my way', gatewayId: 'alpha', createdAt: 1, turnId: TURN_ID };
}

/** Every stream any client was asked to run, across a switch or a re-attach. */
function allStreams(): StreamOptions[] {
  return mockClients.flatMap((client) => client.streams);
}

function streamsForTurn(turnId: string): StreamOptions[] {
  return allStreams().filter((options) => options.turnId === turnId);
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

/** Mount with the durable row already waiting, and let the flush start its send. */
async function mountAndStartQueuedFlush(): Promise<void> {
  await mount();
  await waitFor(() => streamsForTurn(TURN_ID).length > 0);
  await settleStream();
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
  streamScripts = [];
  mockClients.length = 0;
  streamScript = async (_options, onDelta) => {
    onDelta('pong');
    return 'pong';
  };
  observed.gateway = null;
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

/** Start a live send without awaiting it — the turn stays in flight. */
async function startLiveSend(text: string): Promise<() => SendChatInputOutcome | null> {
  let outcome: SendChatInputOutcome | null = null;
  await act(async () => {
    void gatewayApi()
      .sendChatInput(text)
      .then((result) => {
        outcome = result;
      })
      .catch(() => undefined);
  });
  await waitFor(() => allStreams().length > 0);
  await settleStream();
  return () => outcome;
}

describe('a provider-initiated abort leaves the queued line owed', () => {
  beforeEach(async () => {
    mockState.gateways = [profile('alpha')];
    mockState.activeId = 'alpha';
    await saveOfflineQueue([queuedRow()]);
    // The turn the flush starts never ends on its own, and any retry does not
    // either: the row is observed on the durable queue, where the flush keeps
    // everything it still owes.
    streamScript = (options) => hangUntilAborted(options);
  });

  test('Disconnect keeps the row, turn id and all', async () => {
    await mountAndStartQueuedFlush();

    await act(async () => {
      gatewayApi().disconnectGateway();
    });
    await settleStream();

    expect(await loadOfflineQueue()).toEqual([queuedRow()]);
  });

  test('a gateway switch keeps the row for the gateway it was typed on', async () => {
    const beta = profile('beta');
    mockState.gateways = [profile('alpha'), beta];
    await mountAndStartQueuedFlush();

    await act(async () => {
      await gatewayApi().connectGateway(beta);
    });
    await settleStream();

    expect(await loadOfflineQueue()).toEqual([queuedRow()]);
  });

  // Deleting a profile is the one provider path that legitimately takes the
  // owed row with it: deleteGateway purges the queued rows of every removed
  // gateway in the same teardown, so the row cannot outlive the profile it was
  // addressed to. What must NOT happen is the send reporting 'sent' — the words
  // never reached the Gate — so the outcome is what this pins.
  test('deleting the active profile never reports the send as sent', async () => {
    await mount();
    const outcome = await startLiveSend('explain');

    await act(async () => {
      await gatewayApi().deleteGateway('alpha');
    });
    await settleStream();

    expect(outcome()).not.toBe('sent');
    expect(outcome()).not.toBeNull();
    expect(await loadOfflineQueue()).toEqual([]);
  });

  test('the deleted profile purges only its own owed row', async () => {
    mockState.gateways = [profile('alpha'), profile('beta')];
    mockState.activeId = 'alpha';
    await saveOfflineQueue([{ ...queuedRow(), id: 'beta-row', gatewayId: 'beta' }, queuedRow()]);
    await mountAndStartQueuedFlush();

    await act(async () => {
      await gatewayApi().deleteGateway('alpha');
    });
    await settleStream();

    expect(await loadOfflineQueue()).toEqual([{ ...queuedRow(), id: 'beta-row', gatewayId: 'beta' }]);
  });

  test('a re-attach keeps the row', async () => {
    await mountAndStartQueuedFlush();

    await act(async () => {
      mockClients[0].forceDisconnected();
      await gatewayApi().connectGateway(profile('alpha'));
    });
    await settleStream();

    expect(await loadOfflineQueue()).toEqual([queuedRow()]);
  });
});

test('a provider abort is not released by the flush: it is retried with the same turn', async () => {
  mockState.gateways = [profile('alpha')];
  mockState.activeId = 'alpha';
  await saveOfflineQueue([queuedRow()]);
  streamScript = (options) => hangUntilAborted(options);
  await mountAndStartQueuedFlush();

  await act(async () => {
    gatewayApi().disconnectGateway();
  });
  await settleStream();
  expect(await loadOfflineQueue()).toEqual([queuedRow()]);

  // The retry affordance is the row itself: the next connection flushes it
  // again, as the SAME turn, so the Gate replays rather than doing the work
  // twice — and only then is the row released.
  streamScript = async (_options, onDelta) => {
    onDelta('pong');
    return 'pong';
  };
  await act(async () => {
    await gatewayApi().connectGateway(profile('alpha'));
  });
  await settleStream();
  await settle(8, 20);

  expect(streamsForTurn(TURN_ID).length).toBeGreaterThanOrEqual(2);
  expect(await loadOfflineQueue()).toEqual([]);
});

describe("Stop keeps today's behaviour exactly", () => {
  beforeEach(() => {
    mockState.gateways = [profile('alpha')];
    mockState.activeId = 'alpha';
    streamScript = (options) => hangUntilAborted(options);
  });

  test('Stop still resolves sent, so the queued row is not offered back as owed', async () => {
    await saveOfflineQueue([queuedRow()]);
    await mountAndStartQueuedFlush();

    await act(async () => {
      await gatewayApi().stopStreaming();
    });
    await settleStream();

    expect(await loadOfflineQueue()).toEqual([]);
    expect(streamsForTurn(TURN_ID)).toHaveLength(1);
  });

  test('a live send stopped by the operator resolves sent', async () => {
    await mount();
    const outcome = await startLiveSend('explain');

    await act(async () => {
      await gatewayApi().stopStreaming();
    });
    await settleStream();

    expect(outcome()).toBe('sent');
  });

  test('a live send the provider tears down resolves failed', async () => {
    await mount();
    const outcome = await startLiveSend('explain');

    await act(async () => {
      gatewayApi().disconnectGateway();
    });
    await settleStream();

    expect(outcome()).toBe('failed');
  });
});
