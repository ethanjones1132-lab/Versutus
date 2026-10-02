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
import { loadOfflineQueue, saveOfflineQueue } from '@/lib/gateway/session-persistence';
import type { ConnectionStatus, GatewayProfile, HermesSession, SessionMessage } from '@/lib/gateway/types';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';
import type { GatewayManifest } from '@/lib/portal/manifest';

// Two turns can never hold the composer lock at once, so a send that arrives
// while one is in flight — a notification quick reply, a resumed turn, a Retry,
// none of which is the composer — was refused by `sendMessage`'s guard and the
// caller heard nothing: the words reached neither the thread nor the outbox nor
// an error, and the UI cleared the draft. These pin that such a send is parked
// in the durable outbox instead, and that Stop's optimistic unlock cannot let a
// stopped turn's unwind unlock the composer under the turn that replaced it.

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
  /** Every turn id Stop was asked to cancel, with whether the abort had landed. */
  cancels: { turnId: string; streamAborted: boolean }[];
  historyReads: number;
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

function mockMakeClient(callbacks: PortalClientCallbacks, gateway: GatewayProfile): FakeClient {
  let sessionId: string | undefined;
  let connectionStatus: ConnectionStatus = 'disconnected';
  const client = {
    callbacks,
    streams: [] as StreamOptions[],
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

function chatApi(): ChatSurfaceContextValue {
  if (!observed.chat) throw new Error('the provider has not mounted');
  return observed.chat;
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

/** Start a send without awaiting it — the turn stays on screen. */
async function startSend(text: string): Promise<void> {
  await act(async () => {
    void gatewayApi().sendChatInput(text).catch(() => undefined);
  });
  await settleStream();
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
  observed.chat = null;
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
describe('PROV-3: a send a streaming turn turned away is parked, not dropped', () => {
  beforeEach(() => {
    stageActive({ id: 'alpha', url: 'http://alpha.test:8642' });
  });

  test('it lands in the durable outbox and reports queued', async () => {
    streamScript = async (options, onDelta) => {
      onDelta('half an ans');
      return hangUntilAborted(options);
    };
    await mount();
    await startSend('explain');
    expect(chatApi().isSending).toBe(true);

    // The quick-reply shape: no message id of its own, no composer involved.
    let outcome = '';
    await act(async () => {
      outcome = await gatewayApi().sendChatInput('and one more thing');
    });
    await settleStream();

    expect(outcome).toBe('queued');
    // The line is on screen as still owed, not silently gone.
    const owed = chatApi().messages.filter((message) => message.queued && message.text === 'and one more thing');
    expect(owed).toHaveLength(1);
    // And it is durable, so a process killed before the turn finishes still sends it.
    const rows = await loadOfflineQueue();
    expect(rows.map((row) => row.text)).toEqual(['and one more thing']);
    expect(chatApi().messages.some((message) => message.text === 'and one more thing' && !message.queued)).toBe(false);
  });

  test('the parked line is not sent as a second turn while the first is still streaming', async () => {
    streamScript = async (options, onDelta) => {
      onDelta('half an ans');
      return hangUntilAborted(options);
    };
    await mount();
    await startSend('explain');

    await act(async () => {
      await gatewayApi().sendChatInput('and one more thing');
    });
    await settleStream();

    expect(mockClients[0].streams).toHaveLength(1);
  });

  test('a send with nowhere to go offline still queues rather than vanishing', async () => {
    streamScript = async (options, onDelta) => {
      onDelta('half an ans');
      return hangUntilAborted(options);
    };
    await mount();
    await startSend('explain');

    await act(async () => {
      await gatewayApi().disconnectGateway();
    });
    await settleStream();

    const outcome = await gatewayApi().sendChatInput('typed after leaving');
    expect(outcome).toBe('queued');
    const rows = await loadOfflineQueue();
    expect(rows.map((row) => row.text)).toContain('typed after leaving');
  });
});

// Stop clears `isSending` synchronously, before the turn it stopped has actually
// unwound: the abort only stops what this phone is listening to, and the send's
// own `finally` runs some microtasks later. A second send can therefore start in
// that window, and the stopped turn's `finally` must not unlock the composer
// under it. The `finally` writes those flags through an identity guard for
// exactly this reason (`sendingRunIdRef`), which is what this pins.
describe('PROV-6: the stopped turn unwinding cannot unlock the turn that replaced it', () => {
  beforeEach(() => {
    stageActive({ id: 'alpha', url: 'http://alpha.test:8642' });
  });

  /** A stream that ignores its signal until the test releases it, as a late-unwinding adapter does. */
  function lateUnwind(): {
    script: (options: StreamOptions, onDelta: (text: string) => void) => Promise<string>;
    release: () => void;
  } {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      release,
      script: async (_options, onDelta) => {
        onDelta('half an ans');
        await held;
        throw new Error('Chat stream stopped');
      },
    };
  }

  test('a second send inside the window keeps the composer locked', async () => {
    const first = lateUnwind();
    const second: StreamScript = async (options, onDelta) => {
      onDelta('second answer');
      return hangUntilAborted(options);
    };
    streamScripts = [first.script, second];
    await mount();
    await startSend('one');
    expect(chatApi().isSending).toBe(true);

    // Stop: the composer unlocks at once, the stopped turn has not unwound.
    await act(async () => {
      await gatewayApi().stopStreaming();
    });
    expect(chatApi().isSending).toBe(false);

    // The next turn goes out before the stopped one's rejection has landed.
    let secondStream: StreamOptions | null = null;
    await act(async () => {
      void gatewayApi().sendChatInput('two').catch(() => undefined);
    });
    await settleStream();
    expect(chatApi().isSending).toBe(true);
    secondStream = mockClients[0].streams[1];

    // Now the stopped turn unwinds and runs its `finally`.
    await act(async () => {
      first.release();
    });
    await settle(4, 50);

    expect(secondStream?.signal?.aborted).toBe(false);
    expect(chatApi().isSending).toBe(true);
    expect(chatApi().messages.filter((message) => message.streaming)).toHaveLength(1);
  });
});
