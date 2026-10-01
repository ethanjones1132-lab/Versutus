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
import { isStoppedTurn } from '@/lib/gateway/message-reducer';
import type { ConnectionStatus, GatewayProfile, HermesSession, SessionMessage } from '@/lib/gateway/types';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';
import type { GatewayManifest } from '@/lib/portal/manifest';

// A chat turn on this Gate is detachable: the phone's connection can drop while
// the model is still answering and the Gate keeps going. Everything that follows
// from that lives in the provider — Stop has to cancel the turn server-side, the
// partial reply has to survive it, the phone has to come back for a reply it
// never saw stream, and a turn sent without a session has to adopt the session
// the Gate made for it.

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

/**
 * A stream that rejects a tick AFTER its abort, the way a real transport
 * unwinds: the send's catch runs some microtasks after Stop returned.
 */
function unwindAfterAbort(message = 'Chat stream stopped'): StreamScript {
  return async (options, onDelta) => {
    onDelta('half an ans');
    await new Promise<void>((resolve) => {
      if (!options.signal || options.signal.aborted) return resolve();
      options.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    throw new Error(message);
  };
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
      return streamScript(options ?? {}, onDelta);
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

async function emitAppState(state: AppStateStatus): Promise<void> {
  await act(async () => {
    for (const listener of [...appStateListeners]) listener(state);
  });
  await settle(2, 5);
}

/** Start a send without awaiting it — the turn stays on screen. */
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
  mockState.canManageSessions = true;
  mockState.cancelTurnRejects = false;
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

describe('SEND-3: Stop keeps the reply that had already streamed', () => {
  beforeEach(() => {
    stageActive({ id: 'alpha', url: 'http://alpha.test:8642' });
  });

  /** The bubble the turn in flight is writing into. */
  function streamingBubble(): { id: string; text: string } {
    const streaming = chatApi().messages.filter((message) => message.streaming);
    expect(streaming).toHaveLength(1);
    const live = streaming[0];
    if (!live) throw new Error('no turn is streaming');
    return { id: live.id, text: live.text };
  }

  function bubbleById(id: string) {
    return chatApi().messages.find((message) => message.id === id);
  }

  test('leaves the partial text in place, not streaming, marked stopped', async () => {
    streamScript = async (options, onDelta) => {
      options.onTurnId?.('turn-77');
      onDelta('half an ans');
      return hangUntilAborted(options);
    };
    await mount();
    await startSend('explain');
    const live = streamingBubble();
    expect(live.text).toBe('half an ans');

    await act(async () => {
      await gatewayApi().stopStreaming();
    });
    await settleStream();

    const reply = bubbleById(live.id);
    expect(reply?.text).toBe('half an ans');
    expect(reply?.streaming).toBe(false);
    expect(isStoppedTurn(reply!)).toBe(true);
    // Deliberately NOT an interrupted turn: nothing goes looking for a reply
    // the operator chose not to wait for.
    expect(reply?.interrupted).toBeUndefined();
    expect(chatApi().isSending).toBe(false);
  });

  test('the send\'s own abort branch does not then delete the bubble Stop kept', async () => {
    streamScript = async (options, onDelta) => {
      onDelta('half an ans');
      return hangUntilAborted(options);
    };
    await mount();
    await startSend('explain');
    const live = streamingBubble();

    await act(async () => {
      await gatewayApi().stopStreaming();
    });
    // The abort only reaches the send path once the stream rejects; a second
    // round of timers lets that rejection and its reducer call land.
    await settleStream();

    const reply = bubbleById(live.id);
    expect(reply?.text).toBe('half an ans');
    expect(isStoppedTurn(reply!)).toBe(true);
  });

  test('a send that starts before the stopped turn unwinds does not delete the bubble', async () => {
    // The bubble Stop settled is the record — not a flag that a later send can
    // clear out from under the abort branch that follows.
    let calls = 0;
    streamScript = (options, onDelta) => {
      calls += 1;
      if (calls > 1) return hangUntilAborted(options);
      return unwindAfterAbort()(options, onDelta);
    };
    await mount();
    await startSend('explain');
    const live = streamingBubble();

    await act(async () => {
      await gatewayApi().stopStreaming();
    });
    // The next turn goes out before the stopped one's abort has unwound.
    await act(async () => {
      void gatewayApi().sendChatInput('and again').catch(() => undefined);
    });
    await settleStream();
    await settle(4, 50);

    const reply = bubbleById(live.id);
    expect(reply?.text).toBe('half an ans');
    expect(isStoppedTurn(reply!)).toBe(true);
  });

  test('settles every placeholder on screen, not only the run Stop could name', async () => {
    streamScript = async (options, onDelta) => {
      onDelta('half an ans');
      return hangUntilAborted(options);
    };
    await mount();

    // Two turns dispatched in one tick: the second reads the same `isSending`
    // the first has not re-rendered yet, which is how two placeholders
    // coexisted before Stop named a single run.
    await act(async () => {
      void gatewayApi().sendChatInput('one').catch(() => undefined);
      void gatewayApi().sendChatInput('two').catch(() => undefined);
    });
    await settleStream();
    expect(chatApi().messages.filter((message) => message.streaming)).toHaveLength(2);

    await act(async () => {
      await gatewayApi().stopStreaming();
    });
    await settleStream();

    expect(chatApi().messages.some((message) => message.streaming)).toBe(false);
    expect(chatApi().messages.filter((message) => isStoppedTurn(message))).toHaveLength(2);
  });

  test('removes a placeholder that never produced any text', async () => {
    streamScript = async (options) => hangUntilAborted(options);
    await mount();
    await startSend('explain');
    const live = streamingBubble();

    await act(async () => {
      await gatewayApi().stopStreaming();
    });
    await settleStream();

    expect(bubbleById(live.id)).toBeUndefined();
    expect(chatApi().messages.some((message) => message.streaming)).toBe(false);
  });

  test('a delta that arrives after Stop does not put the orb back', async () => {
    // A real transport delivers one more chunk between the abort and the
    // rejection that unwinds the send. Re-streaming the bubble on that delta
    // left a live orb on a turn the operator had already ended, with nothing
    // in flight to ever settle it again.
    streamScript = async (options, onDelta) => {
      onDelta('half an ans');
      return new Promise<string>((_resolve, reject) => {
        options.signal?.addEventListener(
          'abort',
          () => {
            onDelta(' plus a trailing fragment');
          },
          { once: true },
        );
        setTimeout(() => reject(new Error('Chat stream stopped')), 300);
      });
    };
    await mount();
    await startSend('explain');
    const live = streamingBubble();

    await act(async () => {
      await gatewayApi().stopStreaming();
    });
    // Long enough for the batched delta AND the send's own abort branch to land.
    await settle(4, 20);
    await settle(4, 100);

    const reply = bubbleById(live.id);
    expect(reply?.text).toBe('half an ans plus a trailing fragment');
    expect(reply?.streaming).toBe(false);
    expect(isStoppedTurn(reply!)).toBe(true);
    expect(chatApi().messages.some((message) => message.streaming)).toBe(false);
  });
});

describe('BG-1: Stop cancels the turn the Gate is still running', () => {
  beforeEach(() => {
    stageActive({ id: 'alpha', url: 'http://alpha.test:8642' });
  });

  test('names the turn reported by onTurnId, and does so before the local abort', async () => {
    streamScript = async (options, onDelta) => {
      options.onTurnId?.('turn-77');
      onDelta('half an ans');
      return hangUntilAborted(options);
    };
    await mount();
    await startSend('explain');

    await act(async () => {
      await gatewayApi().stopStreaming();
    });
    await settleStream();

    expect(mockClients[0].cancels).toEqual([{ turnId: 'turn-77', streamAborted: false }]);
  });

  test('a Gate with no cancel route cannot turn Stop into an error', async () => {
    mockState.cancelTurnRejects = true;
    streamScript = async (options, onDelta) => {
      options.onTurnId?.('turn-77');
      onDelta('half an ans');
      return hangUntilAborted(options);
    };
    await mount();
    await startSend('explain');

    await act(async () => {
      await gatewayApi().stopStreaming();
    });
    await settleStream();

    expect(mockClients[0].cancels).toHaveLength(1);
    // The refusal is swallowed: it is still the operator's partial reply.
    expect(chatApi().messages.some((message) => isStoppedTurn(message))).toBe(true);
  });

  test('no turn id means nothing to cancel', async () => {
    streamScript = async (options, onDelta) => {
      onDelta('half an ans');
      return hangUntilAborted(options);
    };
    await mount();
    await startSend('explain');

    await act(async () => {
      await gatewayApi().stopStreaming();
    });
    await settleStream();

    expect(mockClients[0].cancels).toEqual([]);
  });

  test('a turn that lands first does not take the running turn\'s id with it', async () => {
    // Two turns dispatched in one tick, each with a turn id of its own. The
    // first one's `finally` cleared the shared slot unconditionally, so Stop
    // found nothing to name and the turn still running on the Gate — the one
    // the operator could see — was never cancelled.
    let calls = 0;
    streamScript = (options, onDelta) => {
      calls += 1;
      if (calls === 1) {
        options.onTurnId?.('turn-first');
        onDelta('first answer');
        return new Promise<string>((resolve) => {
          setTimeout(() => resolve('first answer'), 20);
        });
      }
      options.onTurnId?.('turn-second');
      onDelta('half an ans');
      return hangUntilAborted(options);
    };
    await mount();

    await act(async () => {
      void gatewayApi().sendChatInput('one').catch(() => undefined);
      void gatewayApi().sendChatInput('two').catch(() => undefined);
    });
    await settleStream();
    expect(mockClients[0].streams).toHaveLength(2);
    expect(chatApi().isSending).toBe(false);

    await act(async () => {
      await gatewayApi().stopStreaming();
    });
    await settleStream();

    expect(mockClients[0].cancels).toEqual([{ turnId: 'turn-second', streamAborted: false }]);
  });
});

describe('BG-1: a reply the Gate finished while the phone was not listening', () => {
  beforeEach(() => {
    stageActive({ id: 'alpha', url: 'http://alpha.test:8642' });
  });

  /** A turn that streams a little and then loses the connection. */
  function droppedConnection(): StreamScript {
    return async (_options, onDelta) => {
      onDelta('The answer is');
      throw new Error('Network request failed');
    };
  }

  test('a connection error marks the bubble interrupted and says so', async () => {
    streamScript = droppedConnection();
    await mount();
    await startSend('what is it?');

    const interrupted = chatApi().messages.filter((message) => message.interrupted);
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0].interruptedReason).toBe('Network request failed');
    expect(gatewayApi().lastError).toBe('Network request failed');
  });

  test('the finished reply is found and settled inside the scheduled windows', async () => {
    streamScript = droppedConnection();
    await mount();
    await startSend('what is it?');

    // The Gate kept the turn and finished it; its history now holds the answer.
    mockState.history = [
      { id: 'm1', role: 'user', content: 'what is it?', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: 'The answer is 42.', timestamp: 2 },
    ];
    const readsBefore = mockClients[0].historyReads;

    // Nothing finds the reply until the first recovery window comes due.
    await settle(2, 20);
    expect(mockClients[0].historyReads).toBe(readsBefore);

    await settle(4, 1000);
    await settle(4, 20);

    const texts = chatApi().messages.map((message) => message.text);
    expect(texts).toContain('The answer is 42.');
    expect(chatApi().messages.some((message) => message.interrupted)).toBe(false);
  });

  test('the ladder keeps looking while the bubble is still interrupted', async () => {
    streamScript = droppedConnection();
    await mount();
    await startSend('what is it?');

    // The Gate has not finished the turn yet, so the first window finds nothing.
    const readsBefore = mockClients[0].historyReads;
    await settle(4, 1000);
    await settle(4, 20);
    expect(mockClients[0].historyReads).toBeGreaterThan(readsBefore);
    expect(chatApi().messages.some((message) => message.interrupted)).toBe(true);

    // Still nothing — so the next window looks again rather than giving up.
    const readsAfterFirst = mockClients[0].historyReads;
    await settle(4, 3000);
    await settle(4, 20);
    expect(mockClients[0].historyReads).toBeGreaterThan(readsAfterFirst);
    expect(chatApi().messages.some((message) => message.interrupted)).toBe(true);
  });

  test('a foreground return with an interrupted bubble reconciles it once', async () => {
    streamScript = droppedConnection();
    await mount();
    await startSend('what is it?');
    expect(chatApi().messages.some((message) => message.interrupted)).toBe(true);

    mockState.history = [
      { id: 'm1', role: 'user', content: 'what is it?', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: 'The answer is 42.', timestamp: 2 },
    ];
    const readsBefore = mockClients[0].historyReads;

    await emitAppState('background');
    await emitAppState('active');
    await settle(4, 20);

    expect(mockClients[0].historyReads).toBe(readsBefore + 1);
    const texts = chatApi().messages.map((message) => message.text);
    expect(texts).toContain('The answer is 42.');
    expect(chatApi().messages.some((message) => message.interrupted)).toBe(false);
  });

  test('a foreground return with nothing interrupted reads no history', async () => {
    await mount();
    const readsBefore = mockClients[0].historyReads;

    await emitAppState('background');
    await emitAppState('active');
    await settle(4, 20);

    expect(mockClients[0].historyReads).toBe(readsBefore);
  });

  test('a foreground return leaves the turn that is streaming right now alone', async () => {
    // Turn 1 dies and the Gate never persists the answer, so that bubble is
    // stuck interrupted — `preserveInterruptedAfterReload` re-adds it on every
    // read, which makes *every* later foreground return look like a recovery.
    // Turn 2 is then streaming when the phone is locked. Reconciling there would
    // replace the message list under the live turn: the placeholder would be
    // gone, the deltas that follow would find no id to write into, and the
    // half-written reply would vanish.
    let calls = 0;
    let liveDelta: ((text: string) => void) | null = null;
    streamScript = (options, onDelta) => {
      calls += 1;
      if (calls === 1) return droppedConnection()(options, onDelta);
      liveDelta = onDelta;
      onDelta('live partial');
      return hangUntilAborted(options);
    };
    await mount();
    await startSend('what is it?');
    expect(chatApi().messages.some((message) => message.interrupted)).toBe(true);

    const readsBefore = mockClients[0].historyReads;
    await startSend('and now?');
    const live = chatApi().messages.filter((message) => message.streaming);
    expect(live).toHaveLength(1);
    const liveId = live[0].id;

    await emitAppState('background');
    await emitAppState('active');
    await settleStream();

    const survivor = chatApi().messages.find((message) => message.id === liveId);
    expect(survivor?.text).toBe('live partial');
    expect(survivor?.streaming).toBe(true);
    expect(mockClients[0].historyReads).toBe(readsBefore);

    // Still the same bubble, and still taking deltas: the turn was never
    // detached from the stream it is writing into.
    await act(async () => {
      liveDelta?.(' answer');
    });
    await settleStream();

    const after = chatApi().messages.find((message) => message.id === liveId);
    expect(after?.text).toBe('live partial answer');
    expect(chatApi().messages.filter((message) => message.streaming)).toHaveLength(1);
  });

  test('backgrounding and going inactive flush the owed transcript writes', async () => {
    const flushTranscripts = flushTranscriptsMock();
    await mount();
    expect(flushTranscripts).not.toHaveBeenCalled();

    await emitAppState('inactive');
    expect(flushTranscripts).toHaveBeenCalledTimes(1);

    await emitAppState('background');
    expect(flushTranscripts).toHaveBeenCalledTimes(2);

    // A store that refuses must not take the app down with it.
    flushTranscripts.mockRejectedValueOnce(new Error('store refused'));
    await emitAppState('background');
    expect(flushTranscripts).toHaveBeenCalledTimes(3);
  });

  test('a turn the operator stopped is not one either path goes looking for', async () => {
    streamScript = async (options, onDelta) => {
      onDelta('half an ans');
      return hangUntilAborted(options);
    };
    await mount();
    await startSend('explain');
    await act(async () => {
      await gatewayApi().stopStreaming();
    });
    await settleStream();
    expect(chatApi().messages.some((message) => message.interrupted)).toBe(false);

    // No ladder window reloads for a reply nobody is waiting for.
    const readsBefore = mockClients[0].historyReads;
    await settle(4, 1000);
    await settle(4, 3000);
    await settle(4, 30000);
    expect(mockClients[0].historyReads).toBe(readsBefore);

    // And a background/foreground round trip does not either.
    await emitAppState('background');
    await emitAppState('active');
    await settle(4, 20);
    expect(mockClients[0].historyReads).toBe(readsBefore);
  });

  test('a thread switch drops the ladder armed for the thread being left', async () => {
    streamScript = droppedConnection();
    await mount();
    await startSend('what is it?');
    expect(chatApi().messages.some((message) => message.interrupted)).toBe(true);

    // The switch's own read is refused, so the interrupted bubble is still on
    // screen when the first window comes due — the case where the ladder would
    // reload the thread that was just left into the one now open.
    mockState.historyFails = true;
    await act(async () => {
      gatewayApi().selectSession('live-session');
    });
    await settleStream();
    expect(chatApi().messages.some((message) => message.interrupted)).toBe(true);

    const readsAfterSwitch = mockClients[0].historyReads;
    await settle(4, 1000);
    await settle(4, 3000);
    await settle(4, 30000);
    expect(mockClients[0].historyReads).toBe(readsAfterSwitch);
  });

  test('a Bot Chat open drops the ladder armed for the previous thread', async () => {
    streamScript = droppedConnection();
    await mount();
    await startSend('what is it?');
    expect(chatApi().messages.some((message) => message.interrupted)).toBe(true);

    mockState.historyFails = true;
    await act(async () => {
      await gatewayApi().openBot('bot-1');
    });
    await settleStream();
    expect(chatApi().messages.some((message) => message.interrupted)).toBe(true);

    const readsAfterOpen = mockClients[0].historyReads;
    await settle(4, 1000);
    await settle(4, 3000);
    await settle(4, 30000);
    expect(mockClients[0].historyReads).toBe(readsAfterOpen);
  });

  test('a command that displaced the failing turn does not silence the ladder', async () => {
    // `abortControllerRef` is one slot, and a command takes it from a chat turn
    // that is still in flight (terminal-screen.tsx calls `runAgentCommand`
    // directly). When the command finished it put back the controller it had
    // found there — the turn's, already unwound by then. A dead controller left
    // in the slot reads as "a send is in flight", so every window below stood
    // down and the interrupted bubble was never reconciled: the reply the Gate
    // had finished stayed invisible for the rest of the session.
    let calls = 0;
    streamScript = (options, onDelta) => {
      calls += 1;
      if (calls === 1) {
        onDelta('The answer is');
        return new Promise<string>((_resolve, reject) => {
          setTimeout(() => reject(new Error('Network request failed')), 50);
        });
      }
      return new Promise<string>((resolve) => {
        setTimeout(() => resolve('summary'), 200);
      });
    };
    await mount();

    // The turn goes out first; the command starts while it is still on screen.
    await act(async () => {
      void gatewayApi().sendChatInput('what is it?').catch(() => undefined);
    });
    await settle(1, 10);
    expect(chatApi().isSending).toBe(true);
    await act(async () => {
      void gatewayApi().runAgentCommand('/agent summarise').catch(() => undefined);
    });
    // The turn's connection dies first, so the ladder is armed while the
    // command still holds the slot.
    await settle(2, 60);
    expect(chatApi().messages.some((message) => message.interrupted)).toBe(true);

    // The command lands and unwinds, long after the turn did.
    await settle(4, 50);
    expect(mockClients[0].streams[1].signal?.aborted).toBe(false);

    // The Gate kept the turn and finished it; its history now holds the answer.
    mockState.history = [
      { id: 'm1', role: 'user', content: 'what is it?', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: 'The answer is 42.', timestamp: 2 },
    ];
    const readsBefore = mockClients[0].historyReads;

    await settle(4, 1000);
    await settle(4, 20);

    expect(mockClients[0].historyReads).toBeGreaterThan(readsBefore);
    const texts = chatApi().messages.map((message) => message.text);
    expect(texts).toContain('The answer is 42.');
    expect(chatApi().messages.some((message) => message.interrupted)).toBe(false);
  });
});

describe('SEND-2: a session the Gate made for the turn is adopted once', () => {
  beforeEach(() => {
    // No session catalogue: the phone's thread is empty, exactly as it is when a
    // connect could not read one. The turn's session is the Gate's to report.
    mockState.canManageSessions = false;
    stageActive({ id: 'alpha', url: 'http://alpha.test:8642' });
  });

  test('the announced session is adopted, pinned on the client and persisted', async () => {
    streamScript = async (options, onDelta) => {
      options.onSession?.('sess-from-gate');
      onDelta('pong');
      return 'pong';
    };
    await mount();
    expect(gatewayApi().currentSessionId).toBeUndefined();

    await act(async () => {
      await gatewayApi().sendChatInput('hello');
    });
    await settleStream();

    expect(gatewayApi().currentSessionId).toBe('sess-from-gate');
    expect(mockClients[0].sessionId).toBe('sess-from-gate');
    const saved = mockState.gateways.find((item) => item.id === 'alpha');
    expect(saved?.sessionId).toBe('sess-from-gate');
  });

  test('a session already held is never replaced by one the Gate names', async () => {
    streamScript = async (options, onDelta) => {
      options.onSession?.('sess-first');
      onDelta('pong');
      return 'pong';
    };
    await mount();
    await act(async () => {
      await gatewayApi().sendChatInput('hello');
    });
    await settleStream();
    expect(gatewayApi().currentSessionId).toBe('sess-first');

    // The second turn arrives with a session of its own — a stateless reply,
    // or a Gate that opened one for a Bot Chat. The thread stays put.
    streamScript = async (options, onDelta) => {
      options.onSession?.('sess-second');
      onDelta('again');
      return 'again';
    };
    await act(async () => {
      await gatewayApi().sendChatInput('hello again');
    });
    await settleStream();

    expect(gatewayApi().currentSessionId).toBe('sess-first');
    expect(mockClients[0].sessionId).toBe('sess-first');
  });
});

describe('SEND-4: an agent command can actually be cancelled', () => {
  beforeEach(() => {
    stageActive({ id: 'alpha', url: 'http://alpha.test:8642' });
  });

  test('Cancel aborts the signal the command handed to the stream', async () => {
    // The command answers on its own in 5s unless the abort reaches it — a
    // cancel that only edited the transcript left it running to the end.
    streamScript = (options) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve('summary'), 5_000);
        options.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(abortError());
          },
          { once: true },
        );
      });
    await mount();

    let finished = '';
    let refused = false;
    await act(async () => {
      void gatewayApi()
        .runAgentCommand('/agent summarise')
        .then((text) => {
          finished = text;
        })
        .catch(() => {
          refused = true;
        });
    });
    await settleStream();

    const signal = mockClients[0].streams[0].signal;
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);

    await act(async () => {
      gatewayApi().cancelCommand('cmd-transcript-1');
    });
    await settleStream();

    expect(signal?.aborted).toBe(true);
    expect(refused).toBe(true);
    expect(finished).toBe('');
  });

  test('a finished command leaves no run id for a reconnect to freeze', async () => {
    await mount();

    streamScript = async (_options, onDelta) => {
      onDelta('summary');
      return 'summary';
    };
    await act(async () => {
      await gatewayApi().runAgentCommand('/agent summarise');
    });
    await settleStream();

    // A reconnect: the health check that fires once the client re-attaches.
    // Nothing on screen belongs to that finished command, so nothing freezes.
    const readsBefore = mockClients[0].historyReads;
    await act(async () => {
      mockClients[0].callbacks.onHealthCheck?.(false, HEALTHY as never);
    });
    await settleStream();

    expect(mockClients[0].historyReads).toBe(readsBefore + 1);
    expect(chatApi().messages.some((message) => message.interrupted)).toBe(false);
  });

  test('a chat turn streaming alongside a command is the one Stop settles', async () => {
    streamScript = (options) => hangUntilAborted(options);
    await mount();

    // An agent command hangs, then a chat turn streams on the same client.
    await act(async () => {
      void gatewayApi().runAgentCommand('/agent summarise').catch(() => undefined);
    });
    await settleStream();
    streamScript = async (options, onDelta) => {
      onDelta('half an ans');
      return hangUntilAborted(options);
    };
    await startSend('hello');
    expect(mockClients[0].streams).toHaveLength(2);
    const live = chatApi().messages.filter((message) => message.streaming);
    expect(live).toHaveLength(1);

    await act(async () => {
      await gatewayApi().stopStreaming();
    });
    await settleStream();

    // The turn the operator could see is stopped and kept; the command's own
    // stream is none of Stop's business.
    expect(mockClients[0].streams[1].signal?.aborted).toBe(true);
    expect(mockClients[0].streams[0].signal?.aborted).toBe(false);
    const reply = chatApi().messages.find((message) => message.id === live[0].id);
    expect(reply?.text).toBe('half an ans');
    expect(isStoppedTurn(reply!)).toBe(true);
  });

  test('a chat turn finishing alongside a command does not take its Cancel with it', async () => {
    // Both park a controller in the same ref. A send that finished first used to
    // clear the slot unconditionally, so the command's Cancel found nothing to
    // abort and the gateway kept working.
    let calls = 0;
    streamScript = (options, onDelta) => {
      calls += 1;
      if (calls === 1) {
        onDelta('chat reply');
        // The chat turn lands on its own, after the command has taken the slot.
        return new Promise<string>((resolve) => {
          setTimeout(() => resolve('chat reply'), 50);
        });
      }
      return hangUntilAborted(options);
    };
    await mount();
    // The turn goes out first and is still in flight when the command starts:
    // that is what makes the command take over the one controller slot the
    // send also uses.
    await act(async () => {
      void gatewayApi().sendChatInput('hello').catch(() => undefined);
    });
    await settle(1, 10);
    expect(chatApi().isSending).toBe(true);

    await act(async () => {
      void gatewayApi().runAgentCommand('/agent summarise').catch(() => undefined);
    });
    // The chat turn lands on its own, and its `finally` runs while the command
    // is still streaming.
    await settle(4, 20);

    expect(chatApi().isSending).toBe(false);
    const commandSignal = mockClients[0].streams[1].signal;
    expect(commandSignal?.aborted).toBe(false);

    await act(async () => {
      gatewayApi().cancelCommand('cmd-transcript-1');
    });
    await settleStream();

    expect(commandSignal?.aborted).toBe(true);
  });
});

describe('SEND-4: a cancelled command reads as a cancel, not a failure', () => {
  beforeEach(() => {
    stageActive({ id: 'alpha', url: 'http://alpha.test:8642' });
  });

  test('leaves no banner, no Failed badge, and a cancelled transcript', async () => {
    // `/agent status` dispatches through runAgentCommand, so Cancel has to
    // reach the stream the command handed the client — and the failure it
    // produces must read as the cancel the operator asked for.
    streamScript = (options) => hangUntilAborted(options);
    await mount();

    await act(async () => {
      void gatewayApi().sendChatInput('/agent status').catch(() => undefined);
    });
    await settleStream();
    expect(chatApi().isCommandRunning).toBe(true);
    const bubble = chatApi().messages.find((message) => message.command?.input === '/agent status');
    expect(bubble?.command?.status).toBe('running');

    await act(async () => {
      gatewayApi().cancelCommand(bubble!.id);
    });
    await settleStream();

    const after = chatApi().messages.find((message) => message.id === bubble!.id);
    expect(after?.command?.status).not.toBe('error');
    expect(after?.command?.status).not.toBe('running');
    expect(after?.text).not.toMatch(/failed/i);
    expect(chatApi().isCommandRunning).toBe(false);
    expect(gatewayApi().lastError).toBeNull();
    expect(gatewayApi().commandTranscripts.find((entry) => entry.id === bubble!.id)?.status).toBe(
      'cancelled',
    );
  });
});
