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

// VS-097: a turn the Gate's journal no longer holds.
//
// Retention prunes finished turns, and a Gate restarted on a fresh journal has
// none of them either. The re-attach ladder asks the journal what became of the
// turn it is following, and a null answer is that verdict: gone. Returning on it
// left the bubble streaming with nothing left able to finish it — a permanent
// orb over a reply that would never settle.
//
// Two shapes are pinned here, because they must not be mistaken for each other:
// a resolved null settles the bubble with a named, visible reason (and reloads
// history, which may still hold the reply), while a thrown read stays a retry —
// the journal could not be asked, so the turn's state is unknown, not gone.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

type JournalEvent = {
  seq: number;
  text?: string;
  tool?: ChatToolCall;
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
  /** The seq a turn's stream dies after. */
  dropAt: {} as Record<string, number>,
  /** Turns the journal has pruned: the lookup resolves to null, not a throw. */
  prunedTurns: {} as Record<string, boolean>,
  /** The next N lookups throw, the way a dropped link does. */
  throwNextTurnReads: {} as Record<string, number>,
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

type FakeClient = PortalClient & {
  callbacks: PortalClientCallbacks;
  streams: StreamOptions[];
  /** Every turn-event replay this client served, in order. */
  turnStreams: { turnId: string; after: number; signal?: AbortSignal }[];
  /** Every turn id the journal lookup was asked for, in order. */
  turnReads: string[];
  historyReads: number;
  goConnected(): void;
};

function connectionError(): Error {
  return new Error('Network request failed');
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
    const drops = mockState.dropsLeft[turnId] ?? 0;
    if (drops > 0 && event.seq >= (mockState.dropAt[turnId] ?? Number.POSITIVE_INFINITY)) {
      mockState.dropsLeft[turnId] = drops - 1;
      throw connectionError();
    }
  }
  return { completed: true, text, error: null, lastSeq };
}

function mockMakeClient(callbacks: PortalClientCallbacks, gateway: GatewayProfile): FakeClient {
  let sessionId: string | undefined;
  let connectionStatus: ConnectionStatus = 'disconnected';
  const client = {
    callbacks,
    streams: [] as StreamOptions[],
    turnStreams: [] as { turnId: string; after: number; signal?: AbortSignal }[],
    turnReads: [] as string[],
    historyReads: 0,
    canManageSessions: true,
    get turnsUnsupported() {
      return false;
    },
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
      options?.onAccepted?.(options?.turnId ?? 'turn-unnamed');
      onDelta('pong');
      return 'pong';
    },
    // ─── The turn journal ──────────────────────────────────────────
    listTurns: async (filter?: { sessionId?: string; status?: string }) =>
      Object.values(mockState.turns).filter((turn) => {
        if (filter?.status && turn.status !== filter.status) return false;
        if (filter?.sessionId && turn.sessionId && turn.sessionId !== filter.sessionId) return false;
        return true;
      }),
    getTurn: async (turnId: string) => {
      client.turnReads.push(turnId);
      const throws = mockState.throwNextTurnReads[turnId] ?? 0;
      if (throws > 0) {
        mockState.throwNextTurnReads[turnId] = throws - 1;
        throw connectionError();
      }
      if (mockState.prunedTurns[turnId]) return null;
      return mockState.turns[turnId] ?? null;
    },
    streamTurnEvents: async (turnId: string, options: TurnEventStreamOptions) => {
      client.turnStreams.push({ turnId, after: options.after ?? 0, signal: options.signal });
      return replayTurn(turnId, options);
    },
    cancelTurn: async () => undefined,
    getModels: async () => [{ id: 'm1', object: 'model' }],
    getCapabilities: async () => ({ chat: true, models: true }),
    getSessions: async () => [SESSION],
    createSession: async () => SESSION,
    getSessionMessages: async () => {
      client.historyReads += 1;
      return mockState.history;
    },
    stopRun: async () => undefined,
    setBotId: () => undefined,
    setBackendId: () => undefined,
    suspendReconnect: () => undefined,
    resumeReconnect: () => undefined,
    resumeMonitoring: () => undefined,
  };
  void gateway;
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

async function emitAppState(state: AppStateStatus): Promise<void> {
  await act(async () => {
    for (const listener of [...appStateListeners]) listener(state);
  });
  await settle(2, 5);
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
 * journal already holds, so a turn that is there at connect time is rebuilt by
 * that edge rather than by the foreground return under test.
 */
function stageTurn(
  turnId: string,
  frames: JournalEvent[],
  overrides: Partial<TurnMeta> = {},
): void {
  mockState.turns[turnId] = { turnId, status: 'running', sessionId: 'live-session', ...overrides };
  mockState.journal[turnId] = frames;
}

/** Put the phone through the locked-phone return that arms the follow ladder. */
async function returnToForeground(): Promise<void> {
  await emitAppState('background');
  await emitAppState('active');
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
  mockState.prunedTurns = {};
  mockState.throwNextTurnReads = {};
  mockState.history = [
    { id: 'm1', role: 'user', content: 'ping', timestamp: 1 },
    { id: 'm2', role: 'assistant', content: 'pong', timestamp: 2 },
  ];
  mockClients.length = 0;
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

describe('a turn the journal no longer holds', () => {
  beforeEach(() => {
    stageActive({ id: 'alpha', url: 'http://alpha.test:8642' });
  });

  test('a null lookup settles the bubble with a named reason instead of a permanent orb', async () => {
    await mount();
    stageTurn('turn-pruned', [
      { seq: 1, text: 'The answer ' },
      { seq: 2, text: 'is 42.' },
    ]);
    // One frame arrives, then the link dies: the ladder is armed with the turn
    // following on screen.
    mockState.dropsLeft['turn-pruned'] = 1;
    mockState.dropAt['turn-pruned'] = 1;
    // The Gate then prunes the turn. A pruned turn is a resolved null, not a
    // failed read — the journal answered and the answer is "not here".
    mockState.prunedTurns['turn-pruned'] = true;
    const readsBefore = liveClient().historyReads;

    await returnToForeground();
    expect(bubbleByTurn('turn-pruned')?.streaming).toBe(true);

    // The ladder's first window asks the journal again and gets null.
    await settle(1, 1_000);
    await settleStream();
    await settle(2, 20);

    expect(liveClient().turnReads).toContain('turn-pruned');
    const bubble = bubbleByTurn('turn-pruned');
    // The regression: this used to stay `streaming: true` forever, because the
    // null arm returned without settling anything.
    expect(bubble?.streaming).toBe(false);
    expect(bubble?.interrupted).toBe(true);
    expect(bubble?.interruptedReason).toBe('The PC no longer has a record of this reply.');
    expect(bubble?.text).toBe('The answer ');
    expect(chatApi().isSending).toBe(false);
    // The reply may still be in the conversation itself, so the settle looks.
    expect(liveClient().historyReads).toBeGreaterThan(readsBefore);
  });

  test('a thrown lookup is not pruned: the follow re-arms and finishes the reply', async () => {
    await mount();
    stageTurn('turn-thrown', [
      { seq: 1, text: 'The answer ' },
      { seq: 2, text: 'is 42.' },
    ]);
    mockState.dropsLeft['turn-thrown'] = 1;
    mockState.dropAt['turn-thrown'] = 1;
    // The first re-read fails on the wire. The journal could not be asked, so
    // the state of the turn is unknown — not gone.
    mockState.throwNextTurnReads['turn-thrown'] = 1;

    await returnToForeground();
    expect(bubbleByTurn('turn-thrown')?.streaming).toBe(true);

    // The first window's read throws: the orb stays, because the turn may well
    // still be running and reading it again is the only honest next step.
    await settle(1, 1_000);
    await settleStream();
    expect(bubbleByTurn('turn-thrown')?.streaming).toBe(true);
    expect(bubbleByTurn('turn-thrown')?.interrupted).toBeFalsy();

    // The next window asks again, reads the running turn, and replays the rest.
    await settle(1, 2_000);
    await settleStream();
    await settle(2, 20);

    const bubble = bubbleByTurn('turn-thrown');
    expect(bubble?.text).toBe('The answer is 42.');
    expect(bubble?.streaming).toBe(false);
    expect(bubble?.interrupted).toBeFalsy();
    expect(chatApi().isSending).toBe(false);
  });
});
