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
import { saveOfflineQueue } from '@/lib/gateway/session-persistence';
import type { PublicBot } from '@/lib/gateway/bots';
import type {
  ConnectionStatus,
  GatewayProfile,
  HermesSession,
  SessionMessage,
} from '@/lib/gateway/types';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';
import type { GatewayManifest } from '@/lib/portal/manifest';

// A Bot reply can be finished — the answer is final and on screen — while the
// handoffs that follow it are still out: a roster read plus one `handoffMention`
// call per mentioned Bot. Those calls used to hold the composer lock, so the
// operator's next message was refused as `busy` (and parked in the outbox) after
// the answer had already landed. These pin that the reply's own completion frees
// the composer, while the handoffs keep running in order and still surface their
// own failures.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

type HandoffInput = { fromId: string; toId: string; text: string };

const mockState = {
  gateways: [] as GatewayProfile[],
  activeId: null as string | null,
  settings: { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' },
  manifests: new Map<string, GatewayManifest | null>(),
  history: [
    { id: 'm1', role: 'user', content: 'ping', timestamp: 1 },
    { id: 'm2', role: 'assistant', content: 'pong', timestamp: 2 },
  ] as SessionMessage[],
  roster: [
    { id: 'scout', displayName: 'Scout' },
    { id: 'forge', displayName: 'Forge' },
    { id: 'nova', displayName: 'Nova' },
  ] as PublicBot[],
  /** What the next `handoffMention` does; a test parks or refuses it. */
  handoff: async (_input: HandoffInput): Promise<unknown> => undefined,
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

// Transcript writes are write-behind; the rest of the module is the real one.
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
  streams: StreamOptions[];
  /** Every handoff this client was asked to deliver, in order. */
  handoffs: HandoffInput[];
};

function mockMakeClient(callbacks: PortalClientCallbacks, gateway: GatewayProfile): FakeClient {
  let sessionId: string | undefined;
  let connectionStatus: ConnectionStatus = 'disconnected';
  const client = {
    callbacks,
    streams: [] as StreamOptions[],
    handoffs: [] as HandoffInput[],
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
    listBots: async () => mockState.roster.map((bot) => ({ ...bot })),
    handoffMention: async (input: HandoffInput) => {
      client.handoffs.push({ ...input });
      return mockState.handoff(input);
    },
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
      React.createElement(GatewayProvider, null, React.createElement(Capture)),
    );
  });
  await settle();
}

/** Open a Bot Chat, which is what makes `sendMessage` hand off its @mentions. */
async function openBot(botId: string): Promise<void> {
  let opened = false;
  await act(async () => {
    opened = await gatewayApi().openBot(botId);
  });
  await settle();
  expect(opened).toBe(true);
  expect(gatewayApi().selectedBotId).toBe(botId);
}

beforeEach(async () => {
  jest.useFakeTimers();
  await saveOfflineQueue([]);
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.settings = { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' };
  mockState.manifests = new Map();
  mockState.history = [
    { id: 'm1', role: 'user', content: 'ping', timestamp: 1 },
    { id: 'm2', role: 'assistant', content: 'pong', timestamp: 2 },
  ];
  mockState.handoff = async () => undefined;
  streamScripts = [];
  mockClients.length = 0;
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

describe('the composer unlocks when the reply finishes, not when the handoffs do', () => {
  beforeEach(() => {
    stageActive({ id: 'alpha', url: 'http://alpha.test:8642' });
  });

  test('a parked handoff does not keep the composer locked after the answer lands', async () => {
    let releaseHandoff!: () => void;
    const handoffOut = new Promise<void>((resolve) => {
      releaseHandoff = resolve;
    });
    mockState.handoff = async () => handoffOut;

    await mount();
    await openBot('scout');

    await act(async () => {
      void gatewayApi().sendChatInput('ping @forge').catch(() => undefined);
    });
    await settleStream();

    // The handoff is out and has not answered, and the reply is already final.
    expect(mockClients[0].handoffs).toEqual([
      { fromId: 'scout', toId: 'forge', text: 'ping @forge' },
    ]);
    expect(
      chatApi().messages.some((message) => message.role === 'assistant' && message.text.includes('pong')),
    ).toBe(true);
    // So the composer is the operator's again.
    expect(chatApi().isSending).toBe(false);

    releaseHandoff();
    await settle();
  });

  test('a send during a parked handoff is not turned away and keeps its own turn intact', async () => {
    let releaseHandoff!: () => void;
    const handoffOut = new Promise<void>((resolve) => {
      releaseHandoff = resolve;
    });
    mockState.handoff = async () => handoffOut;

    await mount();
    await openBot('scout');

    let firstOutcome: string | undefined;
    await act(async () => {
      void gatewayApi()
        .sendChatInput('ping @forge')
        .then((outcome) => {
          firstOutcome = outcome;
        })
        .catch(() => undefined);
    });
    await settleStream();
    expect(chatApi().isSending).toBe(false);

    let secondOutcome = '';
    await act(async () => {
      secondOutcome = await gatewayApi().sendChatInput('second message');
    });
    await settleStream();

    expect(secondOutcome).toBe('sent');
    expect(mockClients[0].streams).toHaveLength(2);
    // The first send's unwind, which runs when the handoff finally lands, must
    // not unlock anything under the second turn — nor lock it back up.
    expect(chatApi().isSending).toBe(false);

    releaseHandoff();
    await settle();

    expect(firstOutcome).toBe('sent');
    expect(chatApi().isSending).toBe(false);
  });

  test('handoffs still run in order and still report their own failures', async () => {
    const delivered: string[] = [];
    let releaseFirst!: () => void;
    const firstOut = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mockState.handoff = async (input) => {
      delivered.push(input.toId);
      if (input.toId === 'forge') return firstOut;
      throw new Error('bot offline');
    };

    await mount();
    await openBot('scout');

    await act(async () => {
      void gatewayApi().sendChatInput('ping @forge and @nova').catch(() => undefined);
    });
    await settleStream();

    // The first handoff is still out, so the second has not started: the
    // handoffs stay sequential, exactly as they were before the unlock.
    expect(delivered).toEqual(['forge']);
    expect(chatApi().isSending).toBe(false);

    releaseFirst();
    await settle();

    expect(delivered).toEqual(['forge', 'nova']);
    // The refusal is in the thread, where the operator can see it.
    expect(
      chatApi().messages.some((message) => message.text.includes('Handoff to @nova failed')),
    ).toBe(true);
  });
});
