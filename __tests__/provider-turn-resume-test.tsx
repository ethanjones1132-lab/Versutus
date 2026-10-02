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
import { loadOfflineQueue, type OfflineQueueItem } from '@/lib/gateway/session-persistence';
import type { TurnEventStreamOptions, TurnMeta, TurnStreamResult } from '@/lib/gateway/turns';
import type {
  ChatToolCall,
  ConnectionStatus,
  GatewayProfile,
  HermesSession,
  SessionMessage,
} from '@/lib/gateway/types';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';
import type { GatewayManifest } from '@/lib/portal/manifest';

// The phone side of durable turns. A turn belongs to the Gate: it keeps running
// while the phone is locked, the app is killed, or the connection drops, and the
// phone's job on the way back is to find it, follow it and settle it honestly.
//
// Nothing here reaches the network: the Gate's journal is a fake, which is the
// contract the app codes against (docs/design/durable-turns.md §3).

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
  removeItem: jest.fn(async (key: string) => {
    mockStore.delete(key);
  }),
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

/** The durable stores, so a "process kill" is just a remount over the same bytes. */
const mockStore = new Map<string, string>();

type JournalEvent = {
  seq: number;
  text?: string;
  tool?: ChatToolCall;
  error?: { code: string; message: string };
};

const mockState = {
  gateways: [] as GatewayProfile[],
  activeId: null as string | null,
  settings: { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' },
  manifests: new Map<string, GatewayManifest | null>(),
  history: [
    { id: 'm1', role: 'user', content: 'ping', timestamp: 1 },
    { id: 'm2', role: 'assistant', content: 'pong', timestamp: 2 },
  ] as SessionMessage[],
  /** The journal: what each turn is, and the frames its events carry. */
  turns: {} as Record<string, TurnMeta>,
  journal: {} as Record<string, JournalEvent[]>,
  /** How many more times a turn's stream dies after `dropAt`. */
  dropsLeft: {} as Record<string, number>,
  /** The seq a turn's stream dies after, `Infinity` for never. */
  dropAt: {} as Record<string, number>,
  /**
   * How many times a turn's stream dies BEFORE its first frame — the link is up
   * and the turn is running, but not one line of it arrives. The ladder has
   * nothing to show progress with here, so this is the case its windows exist for.
   */
  blindDrops: {} as Record<string, number>,
  /** A turn whose replay never ends on its own (a long turn on screen). */
  hangs: false,
  /**
   * A replay the test drives frame by frame, for the ordering where a delta has
   * to arrive AFTER a history read has painted the thread.
   */
  manualTurn: null as null | {
    turnId: string;
    deliver: ((seq: number, text?: string) => void) | null;
    finish: (() => void) | null;
  },
  /** A connect that never reaches `connected`, so a send has to park. */
  connectStaysDown: false,
  /** A send whose request never reaches the gateway at all (no 200, no turn). */
  refuseBeforeStream: false,
  /**
   * A send that dies before the stream opens for a reason that is NOT a
   * connection error — a proxy's 5xx, an unclassified transport throw. Nothing
   * in it says the Gate ever saw the turn.
   */
  refuseUnclassified: false,
  /** A gateway with no session support, so the thread never gets a session id. */
  sessionless: false,
  /** Hold the next history read until the test lets it land. */
  holdHistory: false,
  /** Releases the held read, once it has been taken. */
  historyGate: null as null | (() => void),
  /** The gateway refuses `/v1/turns` the way an older Gate does. */
  refuseJournal: false,
  turnsUnsupported: false,
  turnListCalls: 0,
  turnEventCalls: 0,
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

type TurnStreamRead = { turnId: string; after: number; signal?: AbortSignal; at: number };

type FakeClient = PortalClient & {
  callbacks: PortalClientCallbacks;
  streams: StreamOptions[];
  /** Every turn-event replay this client served, in order. */
  turnStreams: TurnStreamRead[];
  cancels: { turnId: string; streamAborted: boolean }[];
  turnListReads: { sessionId?: string; status?: string }[];
  turnReads: string[];
  historyReads: number;
  /** Flip the fake to `connected` the way its own monitor would. */
  goConnected(): void;
};

function connectionError(): Error {
  return new Error('Network request failed');
}

function codedError(code: string, message: string): Error {
  const error = new Error(message);
  (error as Error & { code?: string }).code = code;
  return error;
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

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

function hangTurnUntilAborted(options: TurnEventStreamOptions): Promise<TurnStreamResult> {
  return new Promise<TurnStreamResult>((_resolve, reject) => {
    if (!options.signal) return;
    if (options.signal.aborted) {
      reject(abortError());
      return;
    }
    options.signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

/** The journal's replay, read the way the Gate writes it. */
async function replayTurn(
  turnId: string,
  options: TurnEventStreamOptions,
): Promise<TurnStreamResult> {
  const after = options.after ?? 0;
  let text = '';
  let lastSeq = after;
  for (const event of mockState.journal[turnId] ?? []) {
    if (event.seq <= after) continue;
    options.onSeq?.(event.seq);
    lastSeq = event.seq;
    if (event.text) {
      text += event.text;
      options.onDelta(event.text);
    }
    if (event.tool) options.onToolCall?.(event.tool);
    if (event.error) {
      return { completed: true, text, error: event.error.message, errorCode: event.error.code, lastSeq };
    }
    const drops = mockState.dropsLeft[turnId] ?? 0;
    if (drops > 0 && event.seq >= (mockState.dropAt[turnId] ?? Number.POSITIVE_INFINITY)) {
      mockState.dropsLeft[turnId] = drops - 1;
      throw connectionError();
    }
  }
  if (mockState.hangs) return hangTurnUntilAborted(options);
  return { completed: true, text, error: null, lastSeq };
}

function mockMakeClient(callbacks: PortalClientCallbacks, gateway: GatewayProfile): FakeClient {
  let sessionId: string | undefined;
  let connectionStatus: ConnectionStatus = 'disconnected';
  const client = {
    callbacks,
    streams: [] as StreamOptions[],
    turnStreams: [] as TurnStreamRead[],
    cancels: [] as { turnId: string; streamAborted: boolean }[],
    turnListReads: [] as { sessionId?: string; status?: string }[],
    turnReads: [] as string[],
    historyReads: 0,
    canManageSessions: !mockState.sessionless,
    get turnsUnsupported() {
      return mockState.turnsUnsupported;
    },
    get connectionStatus() {
      return connectionStatus;
    },
    statusDetail: '',
    authRejected: false,
    botId: undefined,
    connect: async () => {
      if (mockState.connectStaysDown) {
        connectionStatus = 'connecting';
        callbacks.onStatus?.('connecting', 'Connecting…');
        return;
      }
      connectionStatus = 'connecting';
      callbacks.onStatus?.('connecting', 'Connecting…');
      connectionStatus = 'connected';
      callbacks.onStatus?.('connected');
      callbacks.onHello?.(HELLO);
      callbacks.onHealthCheck?.(true, HEALTHY as never);
    },
    goConnected: () => {
      connectionStatus = 'connected';
      callbacks.onStatus?.('connected');
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
      if (mockState.refuseBeforeStream) {
        // The request never reached the gateway — a fetch that never connected.
        // No 200, so no stream started and nothing was accepted.
        throw connectionError();
      }
      if (mockState.refuseUnclassified) {
        // Dead before the stream opened, for a reason no classifier can name.
        throw new Error('The upstream proxy answered 503 before the turn was accepted.');
      }
      // The Gate has the turn the moment its stream starts — which is what tells
      // the outbox a queued line may be released.
      options?.onAccepted?.(options?.turnId ?? 'turn-unnamed');
      return streamScript(options ?? {}, onDelta);
    },
    // ─── The turn journal ──────────────────────────────────────────
    listTurns: async (filter?: { sessionId?: string; status?: string }) => {
      mockState.turnListCalls += 1;
      if (mockState.turnsUnsupported) return [];
      client.turnListReads.push({ sessionId: filter?.sessionId, status: filter?.status });
      if (mockState.refuseJournal) {
        // One refusal is a fact about the gateway: the client latches it.
        mockState.turnsUnsupported = true;
        return [];
      }
      return Object.values(mockState.turns).filter((turn) => {
        if (filter?.status && turn.status !== filter.status) return false;
        if (filter?.sessionId && turn.sessionId && turn.sessionId !== filter.sessionId) return false;
        return true;
      });
    },
    getTurn: async (turnId: string) => {
      if (mockState.turnsUnsupported) return null;
      client.turnReads.push(turnId);
      return mockState.turns[turnId] ?? null;
    },
    streamTurnEvents: async (turnId: string, options: TurnEventStreamOptions) => {
      mockState.turnEventCalls += 1;
      if (mockState.turnsUnsupported) {
        return { completed: false, text: '', error: null, lastSeq: options.after ?? 0 };
      }
      client.turnStreams.push({
        turnId,
        after: options.after ?? 0,
        signal: options.signal,
        at: Date.now(),
      });
      const blind = mockState.blindDrops[turnId] ?? 0;
      if (blind > 0) {
        // The stream dies before a single frame: the turn is still running, and
        // nothing has been rendered, so there is no progress to reset anything on.
        mockState.blindDrops[turnId] = blind - 1;
        throw connectionError();
      }
      const manual = mockState.manualTurn;
      if (manual && manual.turnId === turnId) {
        return new Promise<TurnStreamResult>((resolve, reject) => {
          manual.deliver = (seq: number, text?: string) => {
            options.onSeq?.(seq);
            if (text) options.onDelta(text);
          };
          manual.finish = () => resolve({ completed: true, text: '', error: null, lastSeq: 0 });
          options.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
        });
      }
      return replayTurn(turnId, options);
    },
    cancelTurn: async (turnId: string) => {
      client.cancels.push({
        turnId,
        streamAborted: client.streams.some((stream) => stream.signal?.aborted === true),
      });
    },
    getModels: async () => [{ id: 'm1', object: 'model' }],
    getCapabilities: async () => ({ chat: true, models: true }),
    getSessions: async () => [SESSION],
    createSession: async () => SESSION,
    getSessionMessages: async () => {
      client.historyReads += 1;
      if (mockState.holdHistory && !mockState.historyGate) {
        // A full page of history takes its time: the read is held so an attach
        // can land inside it, which is the ordering a reconnect fan-out produces.
        await new Promise<void>((resolve) => {
          mockState.historyGate = resolve;
        });
      }
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

/** The process being reclaimed: the provider goes, the bytes stay. */
async function kill(): Promise<void> {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
  observed.gateway = null;
  observed.chat = null;
  appStateListeners = [];
}

async function emitAppState(state: AppStateStatus): Promise<void> {
  await act(async () => {
    for (const listener of [...appStateListeners]) listener(state);
  });
  await settle(2, 5);
}

async function startSend(text: string): Promise<void> {
  await act(async () => {
    void gatewayApi().sendChatInput(text).catch(() => undefined);
  });
  await settleStream();
}

/** The bubble the turn in flight is writing into. */
function streamingBubble(): { id: string; text: string } {
  const streaming = chatApi().messages.filter((message) => message.streaming);
  expect(streaming).toHaveLength(1);
  const live = streaming[0];
  if (!live) throw new Error('no turn is streaming');
  return { id: live.id, text: live.text };
}

/** The client this process is talking to — a remount builds a new one. */
function liveClient(): FakeClient {
  const client = mockClients[mockClients.length - 1];
  if (!client) throw new Error('no client has been built');
  return client;
}

function bubbleByTurn(turnId: string) {
  return chatApi().messages.find((message) => message.turnId === turnId);
}

/**
 * A turn the Gate is running, as its journal records it.
 *
 * Staged AFTER the mount on purpose: a cold connect re-attaches whatever the
 * journal already holds (that is the app-killed-and-reopened case), so a turn
 * that is there at connect time is rebuilt by that edge rather than by the one
 * under test.
 */
function stageTurn(
  turnId: string,
  frames: JournalEvent[],
  overrides: Partial<TurnMeta> = {},
): void {
  mockState.turns[turnId] = { turnId, status: 'running', sessionId: 'live-session', ...overrides };
  mockState.journal[turnId] = frames;
}

/** Let the held history read land, and settle whatever it sets in motion. */
async function releaseHistory(): Promise<void> {
  const gate = mockState.historyGate;
  mockState.historyGate = null;
  if (!gate) return;
  await act(async () => {
    gate();
  });
  await settle(4, 20);
  await settleStream();
}

beforeEach(() => {
  jest.useFakeTimers();
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.settings = { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' };
  mockState.manifests = new Map();
  mockState.turns = {};
  mockState.journal = {};
  mockState.dropsLeft = {};
  mockState.dropAt = {};
  mockState.blindDrops = {};
  mockState.hangs = false;
  mockState.manualTurn = null;
  mockState.connectStaysDown = false;
  mockState.refuseBeforeStream = false;
  mockState.refuseUnclassified = false;
  mockState.sessionless = false;
  mockState.holdHistory = false;
  mockState.historyGate = null;
  mockState.refuseJournal = false;
  mockState.turnsUnsupported = false;
  mockState.turnListCalls = 0;
  mockState.turnEventCalls = 0;
  mockState.history = [
    { id: 'm1', role: 'user', content: 'ping', timestamp: 1 },
    { id: 'm2', role: 'assistant', content: 'pong', timestamp: 2 },
  ];
  mockClients.length = 0;
  mockStore.clear();
  streamScript = async (_options, onDelta) => {
    onDelta('pong');
    return 'pong';
  };
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
  if (renderer) await kill();
  jest.restoreAllMocks();
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('a foreground return finds the turn the PC is still running', () => {
  beforeEach(() => {
    stageActive({ id: 'alpha', url: 'http://alpha.test:8642' });
  });

  test('the streaming bubble is rebuilt from the replay and finishes on [DONE]', async () => {
    // The phone was locked for minutes with the turn running. The Gate's journal
    // has every frame; the thread has nothing.
    await mount();
    stageTurn('turn-lost', [
      { seq: 1, text: 'The answer ' },
      { seq: 2, text: 'is 42.' },
    ]);

    // Nothing on the thread yet: the reply is the Gate's until the app asks.
    expect(chatApi().messages.some((message) => message.turnId === 'turn-lost')).toBe(false);

    await emitAppState('background');
    await emitAppState('active');
    await settle(4, 20);
    await settleStream();

    const bubble = bubbleByTurn('turn-lost');
    expect(bubble?.text).toBe('The answer is 42.');
    expect(bubble?.interrupted).toBeFalsy();
    // A finished turn is a finished turn: no orb left spinning.
    expect(bubble?.streaming).toBe(false);
    // The thread is not merely "not interrupted" — it is not busy any more.
    expect(chatApi().isSending).toBe(false);
    expect(mockClients[0].turnStreams[0]).toMatchObject({ turnId: 'turn-lost', after: 0 });
  });

  test('while the turn runs, the thread is busy the way a live send is', async () => {
    await mount();
    stageTurn('turn-long', [{ seq: 1, text: 'working on it' }]);
    mockState.hangs = true;

    await emitAppState('background');
    await emitAppState('active');
    await settle(4, 20);
    await settleStream();

    // The existing streaming indicator is what shows this: no new UI, no new
    // affordance — the thread simply reads as busy with a live turn.
    const live = streamingBubble();
    expect(live.text).toBe('working on it');
    expect(chatApi().isSending).toBe(true);
  });

  test('Stop on a re-attached turn cancels that turn by its id', async () => {
    await mount();
    stageTurn('turn-long', [{ seq: 1, text: 'working on it' }]);
    mockState.hangs = true;

    await emitAppState('background');
    await emitAppState('active');
    await settle(4, 20);
    await settleStream();
    const live = streamingBubble();

    await act(async () => {
      await gatewayApi().stopStreaming();
    });
    await settleStream();

    // Named on the Gate, before the local abort — the turn is the host's until told.
    expect(mockClients[0].cancels).toEqual([{ turnId: 'turn-long', streamAborted: false }]);
    const reply = bubbleByTurn('turn-long');
    expect(reply?.text).toBe('working on it');
    expect(isStoppedTurn(reply!)).toBe(true);
    expect(live.id).toBe(reply?.id);
  });

  test('a thread switch stands the re-attach down rather than following the old turn', async () => {
    await mount();
    stageTurn('turn-old', [{ seq: 1, text: 'from the thread being left' }]);
    mockState.hangs = true;

    await emitAppState('background');
    await emitAppState('active');
    await settle(4, 20);
    await settleStream();
    const followed = mockClients[0].turnStreams.length;
    expect(followed).toBeGreaterThan(0);

    await act(async () => {
      gatewayApi().selectSession('other-session');
    });
    await settleStream();

    // The follow belonged to the thread being left: it is released, and nothing
    // re-attaches it under the thread now on screen.
    expect(mockClients[0].turnStreams[0].signal?.aborted).toBe(true);
    expect(mockClients[0].turnStreams).toHaveLength(followed);
  });
});

describe('a replay that keeps dropping is picked up from where it stopped', () => {
  beforeEach(() => {
    stageActive({ id: 'alpha', url: 'http://alpha.test:8642' });
  });

  test('re-attaches from the last seq it rendered, and never shows a word twice', async () => {
    // The old ladder stopped after 20s and re-read history; a turn that drops
    // twice is exactly the case it could not answer.
    await mount();
    stageTurn('turn-flaky', [
      { seq: 1, text: 'The answer ' },
      { seq: 2, text: 'is ' },
      { seq: 3, text: '42.' },
    ]);
    mockState.dropsLeft['turn-flaky'] = 2;
    mockState.dropAt['turn-flaky'] = 2;

    await emitAppState('background');
    await emitAppState('active');
    await settle(4, 20);
    await settleStream();
    // First attempt: seq 1 and 2, then the connection died.
    expect(chatApi().messages.filter((m) => m.turnId === 'turn-flaky')).toHaveLength(1);

    // The ladder's first window, then the second.
    await settle(4, 500);
    await settleStream();
    await settle(4, 1000);
    await settleStream();
    await settle(4, 2500);
    await settleStream();

    const reads = mockClients[0].turnStreams.map((read) => read.after);
    expect(reads).toEqual([0, 2, 3]);
    const bubble = bubbleByTurn('turn-flaky');
    // No duplication, no gap: 'The answer is 42.' exactly once.
    expect(bubble?.text).toBe('The answer is 42.');
    expect(bubble?.streaming).toBe(false);
  });

  test('the ladder does not give up at 20 seconds while the turn is still running', async () => {
    await mount();
    stageTurn('turn-flaky', [
      { seq: 1, text: 'The answer ' },
      { seq: 2, text: 'is ' },
      { seq: 3, text: '42.' },
    ]);
    mockState.dropsLeft['turn-flaky'] = 20;
    mockState.dropAt['turn-flaky'] = 1;

    await emitAppState('background');
    await emitAppState('active');
    await settle(4, 20);
    await settleStream();
    const afterFirst = mockClients[0].turnStreams.length;

    // Minutes of fake time — far past the old 2/8/20s ladder.
    await settle(6, 10_000);
    await settle(6, 30_000);
    await settle(6, 60_000);

    // Every one of those minutes is another attempt, not silence.
    expect(mockClients[0].turnStreams.length).toBeGreaterThan(afterFirst + 2);
    // And each attempt asked the journal whether the turn is still running.
    expect(mockClients[0].turnReads.filter((id) => id === 'turn-flaky').length).toBeGreaterThan(2);
  });

  test('every attempt is asked of the journal, and the windows widen — 1s, 2s, 5s, 10s, 30s, 30s', async () => {
    await mount();
    stageTurn('turn-blind', [{ seq: 1, text: 'The answer is 42.' }]);
    // The phone's stream never opens: not one frame of a turn the PC is running.
    // Nothing is rendered, so nothing counts as progress, and every attempt is a
    // failure the ladder has to back away from — which is the whole point of the
    // windows. A counter that did not survive its own timer asked once a second
    // for the life of the turn (the Gate allows hours), pulsing the stop button
    // and the streaming orb the whole time.
    mockState.blindDrops['turn-blind'] = 100;

    await emitAppState('background');
    await emitAppState('active');
    await settle(4, 20);
    await settleStream();

    // Minutes of fake time, far past every window the ladder holds.
    await settle(90, 1_000);

    const at = mockClients[0].turnStreams.map((read) => read.at);
    expect(at.length).toBeGreaterThan(6);
    const gaps = at.slice(1).map((stamp, index) => stamp - at[index]);
    expect(gaps.slice(0, 6)).toEqual([1_000, 2_000, 5_000, 10_000, 30_000, 30_000]);
    // And each one of those attempts asked the journal rather than assuming.
    expect(mockClients[0].turnReads.filter((id) => id === 'turn-blind').length).toBeGreaterThan(5);
  });

  test('an attach that delivers a frame starts the ladder again at its first window', async () => {
    await mount();
    stageTurn('turn-progress', [
      { seq: 1, text: 'working ' },
      { seq: 2, text: 'on ' },
      { seq: 3, text: 'it ' },
      { seq: 4, text: 'still.' },
    ]);
    // Three attempts die before a frame, so the ladder widens twice; from then on
    // the stream opens and delivers one more frame before it dies, which is
    // progress rather than failure.
    mockState.blindDrops['turn-progress'] = 3;
    mockState.dropsLeft['turn-progress'] = 40;
    mockState.dropAt['turn-progress'] = 1;

    await emitAppState('background');
    await emitAppState('active');
    await settle(4, 20);
    await settleStream();
    await settle(40, 1_000);

    const at = mockClients[0].turnStreams.map((read) => read.at);
    const gaps = at.slice(1).map((stamp, index) => stamp - at[index]);
    // Three blind failures took it to 5s…
    expect(gaps.slice(0, 3)).toEqual([1_000, 2_000, 5_000]);
    // …and a frame arriving after them put it back at the front: a turn that is
    // arriving must not be waited on at 30-second spacing.
    expect(gaps.slice(3, 7)).toEqual([1_000, 1_000, 1_000, 1_000]);
    // Which is why the words are still arriving: every frame reached the thread.
    expect(bubbleByTurn('turn-progress')?.text).toBe('working on it still.');
  });

  test('a turn the journal says has ended is settled instead of followed again', async () => {
    await mount();
    stageTurn('turn-flaky', [
      { seq: 1, text: 'The answer ' },
      { seq: 2, text: 'is ' },
      { seq: 3, text: '42.' },
    ]);
    mockState.dropsLeft['turn-flaky'] = 1;
    mockState.dropAt['turn-flaky'] = 1;

    await emitAppState('background');
    await emitAppState('active');
    await settle(4, 20);
    await settleStream();
    expect(bubbleByTurn('turn-flaky')?.streaming).toBe(true);

    // The Gate finished while the phone was away.
    mockState.turns['turn-flaky'] = {
      turnId: 'turn-flaky',
      status: 'done',
      sessionId: 'live-session',
      text: 'The answer is 42.',
    };
    mockState.dropsLeft['turn-flaky'] = 0;
    await settle(4, 1000);
    await settle(6, 20);
    await settleStream();

    const bubble = bubbleByTurn('turn-flaky');
    expect(bubble?.interrupted).toBeFalsy();
    // History holds no such turn, so the journal's own text is what is shown.
    expect(chatApi().messages.map((message) => message.text)).toContain('The answer is 42.');
  });
});

describe('an interrupted bubble is settled from the turn, not from matching text', () => {
  beforeEach(() => {
    stageActive({ id: 'alpha', url: 'http://alpha.test:8642' });
  });

  test('a turn that finished while this phone was away settles the bubble', async () => {
    // The send named its turn, lost the connection, and the Gate finished it on
    // the PC. Nothing can match that reply by text prefix; the journal can.
    let turnId = '';
    streamScript = async (options, onDelta) => {
      turnId = options.turnId ?? '';
      options.onTurnId?.(turnId);
      onDelta('The answer is');
      mockState.turns[turnId] = {
        turnId,
        status: 'done',
        sessionId: 'live-session',
        text: 'The answer is 42.',
      };
      throw connectionError();
    };
    await mount();
    await startSend('what is it?');

    // Settled by identity: the journal was asked about THIS turn. No history
    // read could have answered it — `mockState.history` holds no such reply, so
    // the prefix heuristic has nothing to match against.
    expect(mockClients[0].turnReads).toContain(turnId);
    // And the bubble that carried the turn id is the one the journal settles, to
    // the answer the journal holds.
    const settled = bubbleByTurn(turnId);
    expect(settled?.text).toBe('The answer is 42.');
    expect(settled?.interrupted).toBeFalsy();
    expect(settled?.streaming).toBe(false);
    expect(chatApi().messages.some((message) => message.interrupted)).toBe(false);
  });

  test('a bubble with no turn id keeps the prefix heuristic it always had', async () => {
    // The journal cannot name this turn (nothing recorded it), so history is
    // still the answer — exactly as before.
    streamScript = async (_options, onDelta) => {
      onDelta('The answer is');
      throw connectionError();
    };
    mockState.history = [
      { id: 'm1', role: 'user', content: 'what is it?', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: 'The answer is 42.', timestamp: 2 },
    ];
    await mount();
    await startSend('what is it?');

    expect(chatApi().messages.some((message) => message.interrupted)).toBe(true);
    await settle(4, 1000);
    await settle(4, 20);
    expect(chatApi().messages.map((message) => message.text)).toContain('The answer is 42.');
  });
});

describe('a Gate restart is an interruption with a reason, never a finished reply', () => {
  beforeEach(() => {
    stageActive({ id: 'alpha', url: 'http://alpha.test:8642' });
  });

  test('the live send ends interrupted, says why, and leaves its tools running', async () => {
    let turnId = '';
    streamScript = async (options, onDelta) => {
      turnId = options.turnId ?? '';
      options.onTurnId?.(turnId);
      options.onToolCall?.({ name: 'read_file', status: 'running' });
      onDelta('half an ans');
      mockState.turns[turnId] = {
        turnId,
        status: 'interrupted',
        sessionId: 'live-session',
        reason: 'gate_restart',
      };
      throw codedError('gate_restart', 'The Gate restarted while this turn was running.');
    };
    await mount();
    await startSend('explain');

    const bubble = bubbleByTurn(turnId);
    expect(bubble?.interrupted).toBe(true);
    expect(bubble?.interruptedReason).toBe('The Gate restarted while this was running.');
    expect(bubble?.text).toBe('half an ans');
    // Not the red failure card, and not a finished answer.
    expect(bubble?.text).not.toMatch(/^Error:/);
    expect(bubble?.streaming).toBe(false);
    // The tool never reported back, so its card must not claim that it did.
    expect(bubble?.toolCalls?.[0].status).toBe('running');
    // The bubble is where this is explained, so the banner stays quiet.
    expect(gatewayApi().lastError).toBeNull();
    // And the journal then has the last word on the turn, which says the same.
    expect(mockClients[0].turnReads).toContain(turnId);
  });

  test('a replay that ends in a restart settles the same way', async () => {
    await mount();
    stageTurn('turn-restarted', [
      { seq: 1, text: 'half an ans' },
      {
        seq: 2,
        error: { code: 'gate_restart', message: 'The Gate restarted while this turn was running.' },
      },
    ]);
    // The Gate is back, and its journal now records what it did to the turn —
    // after the replay has delivered the restart frame, and before the re-attach
    // ladder's first window asks what became of it.
    setTimeout(() => {
      mockState.turns['turn-restarted'] = {
        turnId: 'turn-restarted',
        status: 'interrupted',
        sessionId: 'live-session',
        reason: 'gate_restart',
      };
    }, 300);

    await emitAppState('background');
    await emitAppState('active');
    await settle(4, 20);
    await settleStream();
    await settle(4, 1000);
    await settleStream();

    const bubble = bubbleByTurn('turn-restarted');
    expect(bubble?.interrupted).toBe(true);
    expect(bubble?.interruptedReason).toBe('The Gate restarted while this was running.');
    expect(bubble?.text).toBe('half an ans');
    expect(bubble?.streaming).toBe(false);
  });
});

describe('the offline outbox sends a queued line as the turn it was parked with', () => {
  beforeEach(() => {
    stageActive({ id: 'alpha', url: 'http://alpha.test:8642' });
  });

  /** A line typed while the gateway is down, parked with a turn id of its own. */
  async function parkLine(text = 'on my way'): Promise<void> {
    mockState.connectStaysDown = true;
    await mount();
    await act(async () => {
      await gatewayApi().sendChatInput(text);
    });
    await settleStream();
  }

  /** The row as it sits on disk, with the turn it will be sent as. */
  async function parkedRow() {
    const [parked] = await loadOfflineQueue();
    if (!parked) throw new Error('nothing is queued');
    expect(parked.turnId).toMatch(/^turn-/);
    return parked;
  }

  test('the row keeps its turn id across a process that was killed', async () => {
    await parkLine();
    const parked = await parkedRow();
    await kill();

    // A new process over the same bytes: the line is still owed, under the same
    // turn, so the Gate journals it once however many times it is tried.
    streamScript = async (_options, onDelta) => {
      onDelta('sent at last');
      return 'sent at last';
    };
    mockState.connectStaysDown = false;
    await mount();
    await settleStream();
    await settle(4, 50);

    expect(liveClient().streams[0].turnId).toBe(parked.turnId);
  });

  test('a row is released only once the Gate has accepted the turn', async () => {
    await parkLine();
    await parkedRow();
    await kill();

    streamScript = async (_options, onDelta) => {
      onDelta('sent at last');
      return 'sent at last';
    };
    mockState.connectStaysDown = false;
    await mount();
    await settleStream();
    await settle(4, 50);

    expect(liveClient().streams).toHaveLength(1);
    // The Gate took it — its stream started — so the row is spent.
    expect(await loadOfflineQueue()).toEqual([]);
  });

  test('a send that never reached the Gate leaves the row owed, id and all', async () => {
    await parkLine();
    const parked = await parkedRow();
    await kill();

    // The request never reached the gateway, so no stream started and no turn was
    // accepted — the one outcome that is NOT "the Gate has this line".
    mockState.refuseBeforeStream = true;
    mockState.connectStaysDown = false;
    await mount();
    await settleStream();
    await settle(4, 50);

    // The words are still the operator's, and they will go out as the same turn:
    // dropping the row here is how a queued line used to be lost.
    const [stillOwed] = await loadOfflineQueue();
    expect(stillOwed).toMatchObject({ text: 'on my way', turnId: parked.turnId });
  });

  test('a send that dies before the stream opens for an unnamed reason still owes the row', async () => {
    await parkLine();
    const parked = await parkedRow();
    await kill();

    // The request died before the Gate's stream started, for a reason nothing
    // classifies as a connection error: a 5xx from a proxy in front of the Gate,
    // an unclassified transport throw. No 200 means the Gate never had the turn,
    // so `sent` would be a claim nothing supports — and the outbox acts on it by
    // deleting the operator's words.
    mockState.refuseUnclassified = true;
    mockState.connectStaysDown = false;
    await mount();
    await settleStream();
    await settle(4, 50);

    const owed = await loadOfflineQueue();
    const stillOwed = owed.find((row) => row.text === 'on my way');
    expect(stillOwed?.turnId).toBe(parked.turnId);

    // And what a send reports is the truth about its own turn.
    let outcome = '';
    await act(async () => {
      outcome = await gatewayApi().sendChatInput('are you there?');
    });
    expect(outcome).toBe('failed');
  });

  test('a kill mid-flush re-sends the same turn, so the work is done once', async () => {
    await parkLine();
    const parked = await parkedRow();
    await kill();

    // The first process's send starts and the OS reclaims the process before it
    // settles: the row is still owed, under the turn the Gate is already running.
    streamScript = () => hangUntilAborted({ signal: undefined });
    mockState.connectStaysDown = false;
    await mount();
    await settleStream();
    await kill();

    expect(await loadOfflineQueue()).toHaveLength(1);

    streamScript = async (_options, onDelta) => {
      onDelta('sent at last');
      return 'sent at last';
    };
    await mount();
    await settleStream();
    await settle(4, 50);

    // Two sends, ONE turn id: the second is a replay of the first, not a new
    // turn doing the same work again.
    const turnIds = mockClients.flatMap((client) => client.streams.map((stream) => stream.turnId));
    expect(turnIds).toEqual([parked.turnId, parked.turnId]);
    expect(await loadOfflineQueue()).toEqual([]);
  });
});

describe('a gateway with no journal behaves exactly as it always did', () => {
  beforeEach(() => {
    stageActive({ id: 'alpha', url: 'http://alpha.test:8642' });
    // An older Gate: /v1/turns is not a route it serves.
    mockState.refuseJournal = true;
  });

  test('it is asked once, and the reply is found the way it always was', async () => {
    mockState.history = [
      { id: 'm1', role: 'user', content: 'what is it?', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: 'The answer is 42.', timestamp: 2 },
    ];
    streamScript = async (_options, onDelta) => {
      onDelta('The answer is');
      throw connectionError();
    };
    await mount();
    await startSend('what is it?');

    // The connected edge asked, was refused, and the refusal is now a fact.
    expect(mockClients[0].turnsUnsupported).toBe(true);
    const refusals = mockState.turnListCalls;

    // Today's answer for this gateway: the history ladder, and the reply found
    // in history. No turn streams, and no journal reads after that first refusal.
    await settle(4, 1000);
    await settle(4, 20);
    await emitAppState('background');
    await emitAppState('active');
    await settle(4, 20);

    expect(mockClients[0].turnStreams).toHaveLength(0);
    expect(mockState.turnListCalls).toBe(refusals);
    expect(chatApi().messages.map((message) => message.text)).toContain('The answer is 42.');
  });
});

describe('a re-attach that lands while the thread is still loading history', () => {
  beforeEach(() => {
    stageActive({ id: 'alpha', url: 'http://alpha.test:8642' });
  });

  test('the paint does not take the bubble with it, and the deltas after it still land', async () => {
    await mount();
    stageTurn('turn-race', []);
    // The reconnect fan-out's history read is a full page and the journal read a
    // tiny one, so this is the ordering a device actually produces: the attach
    // wants to land while the load is still open. The replay is driven by hand,
    // so a delta can be delivered after the paint — which is exactly what used to
    // find no bubble to write into and be dropped, leaving the thread busy with
    // nothing streaming.
    mockState.manualTurn = { turnId: 'turn-race', deliver: null, finish: null };
    mockState.holdHistory = true;
    await act(async () => {
      liveClient().goConnected();
    });
    await settle(2, 5);
    await settleStream();

    // Nothing raised into a list that is about to be replaced: the load is open,
    // so the edge waits for it rather than racing it.
    expect(mockClients[0].turnStreams).toHaveLength(0);
    expect(bubbleByTurn('turn-race')).toBeUndefined();

    // The load lands and paints the thread; only now is the turn followed.
    await releaseHistory();
    const deliver = mockState.manualTurn.deliver;
    if (!deliver) throw new Error('the turn was never attached');
    await act(async () => {
      deliver(1, 'The answer ');
    });
    await settleStream();
    await act(async () => {
      deliver(2, 'is 42.');
    });
    await settleStream();

    // Both frames are on screen, in one bubble, and it is still the live turn.
    const bubble = bubbleByTurn('turn-race');
    expect(bubble?.text).toBe('The answer is 42.');
    expect(bubble?.streaming).toBe(true);
    expect(chatApi().messages.filter((message) => message.turnId === 'turn-race')).toHaveLength(1);

    const finish = mockState.manualTurn.finish;
    if (!finish) throw new Error('the turn stream ended early');
    await act(async () => {
      finish();
    });
    await settleStream();

    // And `[DONE]` still settles it.
    expect(bubbleByTurn('turn-race')?.streaming).toBe(false);
    expect(chatApi().isSending).toBe(false);
  });
});

describe('the app killed and reopened, on its first connect', () => {
  beforeEach(() => {
    stageActive({ id: 'alpha', url: 'http://alpha.test:8642' });
  });

  test('the journal is asked, and the turn this session is still running is rebuilt', async () => {
    mockState.hangs = true;
    stageTurn('turn-cold', [{ seq: 1, text: 'still working on it' }]);
    await mount();
    await settle(6, 5);
    await settleStream();

    // This connect is the first one of a new process: `connected` arrives before
    // the render that names the active gateway, so the edge has to be handed the
    // profile it already holds. Before that it asked nothing at all.
    expect(mockState.turnListCalls).toBeGreaterThan(0);
    expect(mockClients[0].turnListReads[0]).toMatchObject({ status: 'running' });
    // And the read was scoped to the thread the history load had just named.
    expect(mockClients[0].turnListReads[0]?.sessionId).toBe('live-session');
    expect(mockClients[0].turnStreams[0]).toMatchObject({ turnId: 'turn-cold', after: 0 });
    const bubble = bubbleByTurn('turn-cold');
    expect(bubble?.text).toBe('still working on it');
    // Busy the way a live send is: the existing streaming indicator is the whole
    // of the re-attach's UI.
    expect(chatApi().isSending).toBe(true);
  });
});

describe('a thread whose session the gateway never named', () => {
  beforeEach(() => {
    stageActive({ id: 'alpha', url: 'http://alpha.test:8642' });
    // A gateway that cannot manage sessions: this thread has no id to scope a
    // journal read by, so the read answers for every thread it is running.
    mockState.sessionless = true;
  });

  test('a running turn of another conversation is never attached to this one', async () => {
    mockState.turns['turn-theirs'] = {
      turnId: 'turn-theirs',
      status: 'running',
      sessionId: 'somebody-elses-thread',
    };
    mockState.journal['turn-theirs'] = [{ seq: 1, text: 'not this conversation' }];
    await mount();
    await emitAppState('background');
    await emitAppState('active');
    await settle(4, 20);
    await settleStream();

    // Asked with nothing to scope it by, and answered for more than this thread.
    expect(mockState.turnListCalls).toBeGreaterThan(0);
    expect(mockClients[0].turnListReads.every((read) => read.sessionId === undefined)).toBe(true);
    // None of those turns is this thread's business, so none is followed.
    expect(mockClients[0].turnStreams).toHaveLength(0);
    expect(chatApi().messages.some((message) => message.turnId === 'turn-theirs')).toBe(false);
  });

  test('a turn this app started is followed all the same — its bubble holds the id', async () => {
    // The send named its turn, lost the connection, and the Gate kept it running
    // on the PC. There is no session to compare against, but this turn is
    // certainly this app's own, so the honest answer is to follow it.
    let turnId = '';
    streamScript = async (options, onDelta) => {
      turnId = options.turnId ?? '';
      options.onTurnId?.(turnId);
      onDelta('half an ans');
      throw connectionError();
    };
    await mount();
    await startSend('what is it?');
    expect(bubbleByTurn(turnId)?.interrupted).toBe(true);

    mockState.turns[turnId] = {
      turnId,
      status: 'running',
      sessionId: 'somebody-elses-thread',
    };
    mockState.journal[turnId] = [{ seq: 1, text: 'and the rest of it.' }];
    await emitAppState('background');
    await emitAppState('active');
    await settle(4, 20);
    await settleStream();

    expect(mockClients[0].turnStreams.map((read) => read.turnId)).toContain(turnId);
    const bubble = bubbleByTurn(turnId);
    expect(bubble?.interrupted).toBe(false);
    expect(bubble?.text).toContain('and the rest of it.');
  });
});

describe('a flush that never got an acceptance keeps the row', () => {
  beforeEach(() => {
    stageActive({ id: 'alpha', url: 'http://alpha.test:8642' });
    // Nothing connects on its own here: the connect is driven by hand so the
    // client can go away mid-batch without a reconnect taking over.
    mockState.settings = { ...mockState.settings, autoConnect: false };
  });

  /** Two lines typed with the gateway down, parked in the durable outbox. */
  async function parkTwo(): Promise<void> {
    await mount();
    await act(async () => {
      await gatewayApi().sendChatInput('first');
      await gatewayApi().sendChatInput('second');
    });
    await settleStream();
    expect((await loadOfflineQueue()).map((row) => row.text)).toEqual(['first', 'second']);
  }

  test('a row whose send met a busy thread is still owed, with its turn id', async () => {
    await parkTwo();

    // The first line goes out; while it is in flight the client goes away, so the
    // second send has nothing to send over and reports `busy`.
    streamScript = async (_options, onDelta) => {
      onDelta('sent at last');
      gatewayApi().disconnectGateway();
      return 'sent at last';
    };
    await act(async () => {
      await gatewayApi().connectGateway(mockState.gateways[0]);
    });
    await settleStream();
    await settle(4, 50);

    // The first row was accepted, so it is spent. The second one was never sent,
    // and 'busy' is not an acceptance: deleting it here is how a queued line
    // used to be lost.
    const owed = await loadOfflineQueue();
    expect(owed.map((row) => row.text)).toEqual(['second']);
    expect(owed[0].turnId).toMatch(/^turn-/);
    expect(mockClients.flatMap((client) => client.streams)).toHaveLength(1);
  });

  /** Two lines typed with the gateway down, then a flush that cannot send them. */
  async function flushThatCannotSend(): Promise<OfflineQueueItem[]> {
    await parkTwo();
    const parked = await loadOfflineQueue();
    // The first line's request dies before the stream opens, so nothing was
    // accepted and the batch ends there — with both rows' words still owed.
    mockState.refuseBeforeStream = true;
    await act(async () => {
      await gatewayApi().connectGateway(mockState.gateways[0]);
    });
    await settleStream();
    await settle(4, 50);
    expect(mockClients.flatMap((client) => client.streams)).toHaveLength(1);
    return parked;
  }

  test('a row the flush could not send is queued on screen again', async () => {
    const parked = await flushThatCannotSend();

    // Those words have not left the phone, so each line is a queued line again.
    // The thread's own history paint re-surfaces them from the queue, which is
    // only possible while the row is ON it.
    expect(chatApi().messages.find((message) => message.id === parked[0].id)?.queued).toBe(true);
    expect(chatApi().messages.find((message) => message.id === parked[1].id)?.queued).toBe(true);
  });

  test('a row the flush could not send is in every LATER durable copy too', async () => {
    const parked = await flushThatCannotSend();

    // Now the operator types another line with the gateway down, and that write
    // is the one that used to lose the stranded rows: they were in the last write
    // of the flush and in no other, so the durable copy it left held only itself.
    await act(async () => {
      gatewayApi().disconnectGateway();
      await gatewayApi().sendChatInput('third');
    });
    await settleStream();

    const owed = await loadOfflineQueue();
    // In the order they were typed, each still the turn it was parked with.
    expect(owed.map((row) => row.text)).toEqual(['first', 'second', 'third']);
    expect(owed.slice(0, 2).map((row) => row.turnId)).toEqual([
      parked[0].turnId,
      parked[1].turnId,
    ]);
  });
});

describe('a live send that drops mid-reply re-attaches without showing its reply twice', () => {
  beforeEach(() => {
    stageActive({ id: 'alpha', url: 'http://alpha.test:8642' });
  });

  test('the replay from the journal start replaces what the live stream already showed', async () => {
    // The socket dies after the first frame and the Gate keeps running the turn.
    // The live stream recorded no journal seq, so the re-attach starts at 0 and
    // the replay carries the turn from its first frame: the text already on the
    // bubble is a prefix of it and must be replaced, not appended to.
    let turnId = '';
    streamScript = async (options, onDelta) => {
      turnId = options.turnId ?? '';
      options.onTurnId?.(turnId);
      onDelta('partial ');
      mockState.turns[turnId] = { turnId, status: 'running', sessionId: 'live-session' };
      mockState.journal[turnId] = [
        { seq: 1, text: 'partial ' },
        { seq: 2, text: 'and the rest' },
      ];
      throw connectionError();
    };
    await mount();
    await startSend('what is it?');
    await settle(4, 20);

    const bubble = bubbleByTurn(turnId);
    expect(bubble?.text).toBe('partial and the rest');
    expect(chatApi().messages.filter((message) => message.turnId === turnId)).toHaveLength(1);
  });
});
