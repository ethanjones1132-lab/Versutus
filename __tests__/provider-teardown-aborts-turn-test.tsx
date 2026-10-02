import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

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

// CONN-4, the provider half. A turn's abort signal belongs to the provider, and
// the two paths that throw a client away — a gateway switch and an explicit
// disconnect — called `client.disconnect()` and nothing else. The client could
// not stop that turn even in principle, so the old stream kept reading frames
// for a thread the phone had left while the socket stayed open on the Gate; and
// the abandoned send's `finally` cleared `isSending` and the run id over the top
// of whatever turn had taken its place.

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
/** What the Gate's history endpoint answers; the recovery ladder re-reads it. */
let history: SessionMessage[] = [{ id: 'm1', role: 'user', content: 'ping', timestamp: 1 }];

type StreamOptions = NonNullable<Parameters<PortalClient['streamChat']>[2]>;

type FakeClient = PortalClient & {
  id: string;
  /** The signal each turn's stream actually ran under. */
  signals: (AbortSignal | undefined)[];
  /** Every run id this client was asked to look up, in order. */
  runStatusAsks: string[];
  disconnects: number;
  streams: StreamOptions[];
};

/** A turn that streams a little and then never ends, until it is aborted. */
function hangUntilAborted(options: StreamOptions): Promise<string> {
  return new Promise<string>((_resolve, reject) => {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    if (!options.signal) return;
    if (options.signal.aborted) {
      reject(error);
      return;
    }
    options.signal.addEventListener('abort', () => reject(error), { once: true });
  });
}

function mockMakeClient(callbacks: PortalClientCallbacks): FakeClient {
  let sessionId: string | undefined;
  let connectionStatus: ConnectionStatus = 'disconnected';
  const client = {
    id: '',
    signals: [] as (AbortSignal | undefined)[],
    runStatusAsks: [] as string[],
    disconnects: 0,
    streams: [] as StreamOptions[],
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
      client.disconnects += 1;
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
      client.signals.push(options?.signal);
      onDelta('half an ans');
      return streamScript(options ?? {}, onDelta);
    },
    getModels: async () => [{ id: 'm1', object: 'model' }],
    getCapabilities: async () => ({ chat: true, models: true }),
    getSessions: async () => [SESSION],
    createSession: async () => SESSION,
    getSessionMessages: async () => history,
    getRunStatus: async (runId: string) => {
      client.runStatusAsks.push(runId);
      return { run_id: runId, status: 'completed', result: 'the finished answer' };
    },
    stopRun: async () => undefined,
    setBotId: () => undefined,
    setBackendId: () => undefined,
    suspendReconnect: () => undefined,
    resumeReconnect: () => undefined,
  };
  return client as unknown as FakeClient;
}

const mockClients: FakeClient[] = [];

let streamScript: (options: StreamOptions, onDelta: (text: string) => void) => Promise<string> =
  async (_options, onDelta) => {
    onDelta('pong');
    return 'pong';
  };

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

async function settleStream(): Promise<void> {
  await settle(4, 20);
}

function profile(id: string, url: string): GatewayProfile {
  return { name: id, kind: 'hermes', token: 'token-1', createdAt: 0, id, url } as GatewayProfile;
}

function stageActive(id = 'alpha'): GatewayProfile {
  const staged = profile(id, `http://${id}.test:8642`);
  mockState.gateways = [staged];
  mockState.activeId = staged.id;
  return staged;
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

async function startSend(text: string): Promise<void> {
  await act(async () => {
    void gatewayApi().sendChatInput(text).catch(() => undefined);
  });
  await settleStream();
}

beforeEach(() => {
  jest.useFakeTimers();
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.settings = { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' };
  mockState.manifests = new Map();
  history = [{ id: 'm1', role: 'user', content: 'ping', timestamp: 1 }];
  mockClients.length = 0;
  streamScript = async (_options, onDelta) => {
    onDelta('pong');
    return 'pong';
  };
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

describe('a client that is thrown away takes its turn with it', () => {
  test('disconnecting aborts the turn that is streaming', async () => {
    streamScript = (options) => hangUntilAborted(options);
    stageActive();
    await mount();
    await startSend('explain');

    const signal = mockClients[0].signals[0];
    expect(signal?.aborted).toBe(false);

    await act(async () => {
      gatewayApi().disconnectGateway();
    });
    await settleStream();

    // The socket the abandoned turn held open on the Gate is closed by this.
    expect(signal?.aborted).toBe(true);
    expect(mockClients[0].disconnects).toBe(1);
    expect(chatApi().isSending).toBe(false);
  });

  test('switching gateways aborts the turn the old client was streaming', async () => {
    streamScript = (options) => hangUntilAborted(options);
    stageActive('alpha');
    const second = profile('beta', 'http://beta.test:8642');
    mockState.gateways = [profile('alpha', 'http://alpha.test:8642'), second];
    mockState.activeId = 'alpha';
    await mount();
    await startSend('explain');

    const signal = mockClients[0].signals[0];
    expect(signal?.aborted).toBe(false);

    await act(async () => {
      await gatewayApi().connectGateway(second);
    });
    await settle();

    expect(signal?.aborted).toBe(true);
  });
});

describe('an abandoned turn does not clear the turn that replaced it', () => {
  test('a turn that unwinds late leaves a live turn\'s sending flag alone', async () => {
    // Two turns dispatched in one tick: the second owns the shared slots. The
    // first one's `finally` used to clear `isSending` unconditionally, which
    // unlocked the composer under a reply that was still streaming and left Stop
    // with no run id to name.
    let calls = 0;
    streamScript = (options, onDelta) => {
      calls += 1;
      if (calls === 1) {
        onDelta('first answer');
        return new Promise<string>((resolve) => {
          setTimeout(() => resolve('first answer'), 50);
        });
      }
      onDelta('half an ans');
      return hangUntilAborted(options);
    };
    stageActive();
    await mount();

    await act(async () => {
      void gatewayApi().sendChatInput('one').catch(() => undefined);
      void gatewayApi().sendChatInput('two').catch(() => undefined);
    });
    await settleStream();
    expect(mockClients[0].streams).toHaveLength(2);

    // The first turn lands while the second is still on screen.
    await settle(6, 30);

    expect(chatApi().isSending).toBe(true);
    expect(chatApi().messages.filter((message) => message.streaming)).toHaveLength(1);
  });

  test('the flag does come down once the last turn ends', async () => {
    stageActive();
    await mount();
    await startSend('explain');
    expect(chatApi().isSending).toBe(false);
  });
});

describe('the recovery ladder never asks the Gate about a chat bubble', () => {
  test('an interrupted chat turn costs no run lookup on a lossy link', async () => {
    // A chat turn's bubble is keyed `run-<local id>`; the Gate never issued a run
    // for it. Each recovery window used to ask anyway — three windows per
    // interrupted bubble — and the answer, an error, was thrown away, so the
    // bubble settled from history exactly as before while the Gate resolved a
    // run backend for a run that does not exist.
    streamScript = async () => {
      throw new Error('Network request failed');
    };
    stageActive();
    // The Gate kept the turn and finished it; its history now holds the answer.
    history = [
      { id: 'm1', role: 'user', content: 'what is it?', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: 'half an ans continued to completion', timestamp: 2 },
    ];
    await mount();
    await startSend('what is it?');
    expect(chatApi().messages.some((message) => message.interrupted)).toBe(true);

    // Every window the ladder arms, all three of them.
    await settle(4, 1000);
    await settle(4, 20);
    await settle(4, 3000);
    await settle(4, 30_000);

    expect(mockClients[0].runStatusAsks).toEqual([]);
    // And the bubble is still settled the way it always was: from history, which
    // is the read the ladder exists for.
    expect(chatApi().messages.map((message) => message.text)).toContain('half an ans continued to completion');
    expect(chatApi().messages.some((message) => message.interrupted)).toBe(false);
  });
});
