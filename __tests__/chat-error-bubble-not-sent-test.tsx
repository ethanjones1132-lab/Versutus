// VS-100. A failed turn leaves an `Error: …` bubble in the thread. That text is
// the app's notice, not a model reply, so the next send's context must not carry
// it back as an assistant turn. The bubble stays on screen either way; only what
// travels to the model changes. A replay that fills the same bubble with model
// output is genuine assistant text again, so its marker must not outlive the
// notice.

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import {
  GatewayProvider,
  useChatSurface,
  useGateway,
  type GatewayContextValue,
  type SendChatInputOutcome,
} from '@/context/gateway-provider';
import {
  addStreamingPlaceholder,
  appendStreamDelta,
  convertStreamError,
  markTurnStreaming,
} from '@/lib/gateway/message-reducer';
import type {
  ChatMessage,
  ConnectionStatus,
  GatewayProfile,
  HermesSession,
  SessionMessage,
} from '@/lib/gateway/types';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';
import type { GatewayManifest } from '@/lib/portal/manifest';

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

type StreamOptions = NonNullable<Parameters<PortalClient['streamChat']>[2]>;
type WireMessage = { role: string; content: unknown };
type StreamScript = (options: StreamOptions, onDelta: (text: string) => void) => Promise<string>;

type FakeClient = PortalClient & {
  id: string;
  /** Every turn this client was asked to run, with the exact context it got. */
  calls: { messages: WireMessage[]; options: StreamOptions }[];
};

/** Every stream any client ran, in order — a reconnect cannot hide a send. */
const streamCalls: { messages: WireMessage[]; options: StreamOptions }[] = [];

function mockMakeClient(callbacks: PortalClientCallbacks): FakeClient {
  let sessionId: string | undefined;
  // Annotated, not inferred: a narrower literal type here is what made the
  // previous attempt fail to type-check when `connect` moved it on.
  let connectionStatus: ConnectionStatus = 'disconnected';
  const client = {
    id: '',
    calls: [] as { messages: WireMessage[]; options: StreamOptions }[],
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
      messages: WireMessage[],
      onDelta: (text: string) => void,
      options?: StreamOptions,
    ) => {
      const request = options ?? {};
      client.calls.push({ messages, options: request });
      streamCalls.push({ messages, options: request });
      // A scripted answer runs; a scripted refusal rejects and the provider
      // settles the bubble the way it does on the device.
      return (streamScripts.shift() ?? answer('pong'))(request, onDelta);
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

/** Scripts for the next streams, in order. */
let streamScripts: StreamScript[] = [];

/** A stream that answers with `text`. */
function answer(text: string): StreamScript {
  return async (_options, onDelta) => {
    onDelta(text);
    return text;
  };
}

/** A stream the Gate refuses: not a connection error, not an abort. */
function refusal(message: string): StreamScript {
  return async () => {
    throw new Error(message);
  };
}

const observed: {
  gateway: GatewayContextValue | null;
  surface: ReturnType<typeof useChatSurface> | null;
} = { gateway: null, surface: null };

function Capture(): null {
  observed.gateway = useGateway();
  observed.surface = useChatSurface();
  return null;
}

function gatewayApi(): GatewayContextValue {
  if (!observed.gateway) throw new Error('the provider has not mounted');
  return observed.gateway;
}

function surface() {
  if (!observed.surface) throw new Error('the provider has not mounted');
  return observed.surface;
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

/** Settle until a condition holds — connect and the history read are async. */
async function waitFor(check: () => boolean, rounds = 80, ms = 5): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    if (check()) return;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }
  throw new Error('the expected condition never held');
}

function profile(id: string): GatewayProfile {
  return { name: id, kind: 'hermes', token: 'token-1', createdAt: 0, id, url: `http://${id}.test:8642` } as GatewayProfile;
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
  await waitFor(() => observed.gateway?.status === 'connected');
  // Let the connect-time history read land before the first turn, so a late
  // repaint cannot run over the thread the test is about to build.
  await settleStream();
}

/** Send one line and let its turn settle, success or failure. */
async function send(text: string, turnId?: string): Promise<SendChatInputOutcome> {
  let outcome: SendChatInputOutcome = 'failed';
  await act(async () => {
    outcome = await gatewayApi().sendChatInput(text, turnId ? { turnId } : undefined);
  });
  await settleStream();
  return outcome;
}

/** The context turn `index` was actually handed. */
function wire(index: number): WireMessage[] {
  const call = streamCalls[index];
  if (!call) throw new Error(`no stream was started for turn ${index}`);
  return call.messages;
}

function rendered(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function isErrorNotice(message: WireMessage): boolean {
  return message.role === 'assistant' && rendered(message.content).startsWith('Error:');
}

beforeEach(async () => {
  jest.useFakeTimers();
  mockState.gateways = [profile('alpha')];
  mockState.activeId = 'alpha';
  mockState.settings = { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' };
  mockState.manifests = new Map();
  mockState.history = [];
  streamScripts = [];
  streamCalls.length = 0;
  mockClients.length = 0;
  observed.gateway = null;
  observed.surface = null;
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

describe('a failed turn is a notice, not model output', () => {
  test('the next send leaves the error bubble out and keeps the real turns', async () => {
    streamScripts = [
      answer('the first answer'),
      refusal('the model rejected the turn'),
      answer('the third answer'),
    ];
    await mount();

    expect(await send('first question')).toBe('sent');
    expect(await send('second question')).toBe('failed');
    // The operator still sees what happened: the notice is on the thread.
    expect(
      surface().messages.some(
        (message) => message.role === 'assistant' && message.text.startsWith('Error:'),
      ),
    ).toBe(true);

    expect(await send('third question')).toBe('sent');

    const context = wire(2);
    expect(context).toContainEqual({ role: 'user', content: 'first question' });
    expect(context).toContainEqual({ role: 'assistant', content: 'the first answer' });
    expect(context).toContainEqual({ role: 'user', content: 'second question' });
    expect(context).toContainEqual({ role: 'user', content: 'third question' });
    // The app's own error copy is not an assistant turn.
    expect(context.some(isErrorNotice)).toBe(false);
  });

  test('a replay that replaces the notice with model output sends that text', async () => {
    streamScripts = [
      refusal('the model rejected the turn'),
      answer('the real answer'),
      answer('later answer'),
    ];
    await mount();

    // The same turn id is the outbox resend of this line: its bubble already
    // holds the failed turn's notice.
    expect(await send('the failed line', 'turn-replayed')).toBe('failed');
    expect(await send('the failed line', 'turn-replayed')).toBe('sent');
    expect(await send('next question')).toBe('sent');

    const context = wire(2);
    expect(context).toContainEqual({ role: 'assistant', content: 'the real answer' });
    // The notice was replaced, so nothing marks the bubble synthetic any more.
    expect(context.some(isErrorNotice)).toBe(false);
  });
});

describe('the reducer clears the marker when model output fills the bubble', () => {
  test('a turn-journal replay replaces the notice and drops the marker', () => {
    let messages: ChatMessage[] = addStreamingPlaceholder([], 'turn-1', 'turn-1');
    messages = convertStreamError(messages, 'turn-1', 'the model rejected the turn', false);
    expect(messages[0].synthetic).toBe('error');

    messages = markTurnStreaming(messages, 'turn-1', true);
    messages = appendStreamDelta(messages, 'turn-1', 'the real answer');

    expect(messages[0].text).toBe('the real answer');
    expect(messages[0].synthetic).toBeUndefined();
  });
});
