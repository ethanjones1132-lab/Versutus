import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import {
  GatewayProvider,
  useChatSurface,
  useGateway,
  type ChatSurfaceContextValue,
  type GatewayContextValue,
} from '@/context/gateway-provider';
import { upsertGateway } from '@/lib/gateway/storage';
import type { ConnectionStatus, GatewayProfile } from '@/lib/gateway/types';
import type { AccessRequestResult } from '@/lib/portal/access';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';

// VS-156: a Deny on the PC pair page must stick.
//
// The pairing poll used to have no terminal state: `pending` re-armed, a grant
// connected, and every other outcome — `denied` included — fell through to the
// unconditional `setTimeout(poll, 3000)`. So a Gate that refused this phone got
// the same request re-filed every three seconds, forever, while the screen
// looked like it was still waiting for approval.
//
// These tests drive the real provider through `setupFromPcAddress` (the typed
// address, blank key path) until it parks in pairing recovery, then let the
// pairing poll run on fake timers and count what it asks the Gate for.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

const GATE_URL = 'http://my-pc.tail1234.ts.net:8760';
/** The same address the way the operator types it: no scheme. */
const GATE_HOST = 'my-pc.tail1234.ts.net:8760';
const STATUS_PATH = '/.well-known/gateway/access/status';

const mockState: {
  gateways: GatewayProfile[];
  activeId: string | null;
  settings: Record<string, unknown>;
  /** What this attempt's poll asks the Gate for: a status body, or a refusal. */
  statusBody: Record<string, unknown>;
  /** A status read that never answers, the transient-offline shape. */
  statusThrows: boolean;
  /** The one access request `setupFromPcAddress` itself files. */
  setupAccess: AccessRequestResult;
  /** What every later access request (the poll's) answers. */
  accessResult: AccessRequestResult;
} = {
  gateways: [],
  activeId: null,
  settings: {
    autoConnect: false,
    onboardingComplete: true,
    voiceEngine: 'auto',
    tailscaleHost: 'my-pc.tail1234.ts.net',
  },
  statusBody: { status: 'denied' },
  statusThrows: false,
  setupAccess: { status: 'pending-approval', requestId: 'req-1' },
  accessResult: { status: 'denied', reason: 'device grant revoked' },
};

/** Every `requestGatewayAccess` call, in order. */
const mockAccessCalls: string[] = [];
/** Every pairing-status read, in order. */
const mockStatusReads: string[] = [];

jest.mock('@/lib/gateway/storage', () => ({
  loadGateways: jest.fn(async () => mockState.gateways.map((item) => ({ ...item }))),
  saveGateways: jest.fn(async () => undefined),
  removeGatewayIds: jest.fn(async () => mockState.gateways.map((item) => ({ ...item }))),
  upsertGateway: jest.fn(async (gateway: GatewayProfile) => {
    mockState.gateways = mockState.gateways.some((item) => item.id === gateway.id)
      ? mockState.gateways.map((item) => (item.id === gateway.id ? { ...gateway } : item))
      : [...mockState.gateways, { ...gateway }];
    return mockState.gateways.map((item) => ({ ...item }));
  }),
  removeGateway: jest.fn(async () => mockState.gateways.map((item) => ({ ...item }))),
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
  createGatewayProfile: jest.fn((input: { name: string; url: string; token?: string }) => ({
    ...input,
    id: `created-${input.url}`,
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
  probeHighPriorityCandidates: jest.fn(async (urls: string[]) => {
    // Written out because a jest.mock factory cannot close over GATE_URL.
    const winner = urls.find((url) => url === 'http://my-pc.tail1234.ts.net:8760');
    return winner ? { ok: true, url: winner, latencyMs: 0, hasManifest: true } : null;
  }),
}));

jest.mock('@/lib/portal/manifest', () => {
  const actual = jest.requireActual<typeof import('@/lib/portal/manifest')>('@/lib/portal/manifest');
  return {
    ...actual,
    // The Gate's identity is scripted below, so no manifest read is wanted.
    fetchGatewayManifestWithLookupRetry: jest.fn(async () => null),
  };
});

// The pairing identity is a Gate with a signed access endpoint — the only
// shape `setupFromPcAddress` parks in pairing recovery for.
jest.mock('@/lib/portal/identify', () => ({
  identifyGateway: jest.fn(async () => ({
    kind: 'custom',
    kindLabel: 'Versutus Gate',
    manifest: { auth: { grantPath: '/.well-known/gateway/access', schemes: ['bearer'] } },
    auth: { schemes: ['bearer'], requiresToken: true, grantPath: '/.well-known/gateway/access' },
    source: 'manifest',
    identifiedAt: 0,
  })),
}));

jest.mock('@/lib/portal/access', () => ({
  requestGatewayAccess: jest.fn(async () => {
    mockAccessCalls.push('request');
    if (mockAccessCalls.length === 1) return mockState.setupAccess;
    return mockState.accessResult;
  }),
}));

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

jest.mock('@/lib/notifications/routine-sync', () => ({
  rearmRoutineNotifications: jest.fn(async () => undefined),
  syncRoutineNotification: jest.fn(async () => undefined),
  cancelRoutineNotification: jest.fn(async () => undefined),
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

/** What a grant's connect does: one client, one connect, connected. */
type FakeClient = PortalClient & { connectCalls: number };
const mockClients: FakeClient[] = [];

function mockMakeClient(callbacks: PortalClientCallbacks): FakeClient {
  const client = {
    connectionStatus: 'disconnected' as ConnectionStatus,
    statusDetail: '',
    authRejected: false,
    botId: undefined,
    canManageSessions: true,
    connectCalls: 0,
    connect: async () => {
      client.connectCalls += 1;
      callbacks.onStatus?.('connecting', 'Connecting…');
      callbacks.onStatus?.('connected');
      callbacks.onHello?.({ type: 'hello-ok', protocol: 1, server: { version: '0.18.0' } } as never);
    },
    disconnect: () => undefined,
    updateProfile: () => undefined,
    sessionId: undefined,
    healthCheck: async () => ({ status: 'ok' }),
    rpcRequest: async () => ({}),
    streamChat: async () => 'pong',
    getModels: async () => [],
    getCapabilities: async () => ({ chat: true, models: true }),
    getSessions: async () => [],
    createSession: async () => ({ id: 'session-1', title: '', createdAt: 0 }),
    getSessionMessages: async () => [],
    stopRun: async () => undefined,
    setBotId: () => undefined,
    setBackendId: () => undefined,
    suspendReconnect: () => undefined,
    resumeReconnect: () => undefined,
    forceReconnect: () => undefined,
  } as unknown as FakeClient;
  return client;
}

jest.mock('@/lib/portal/adapters', () => ({
  createClientForKind: jest.fn((_kind: string, _gateway: GatewayProfile, callbacks: PortalClientCallbacks) => {
    const client = mockMakeClient(callbacks);
    mockClients.push(client);
    return client;
  }),
}));

/** The Gate as this phone sees it during a poll: health, and the pair status. */
const gateFetch = jest.fn(async (input: unknown) => {
  const url = String(input);
  if (url.includes(STATUS_PATH)) {
    mockStatusReads.push(url);
    if (mockState.statusThrows) throw new TypeError('Network request failed');
    return new Response(JSON.stringify(mockState.statusBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});

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

let renderer: TestRenderer.ReactTestRenderer | null = null;

/** Drain promises without letting a single millisecond of fake time run. */
async function settle(rounds = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
  }
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
  // Let anything the due timer started settle before the assertion reads.
  await settle(4);
}

async function mount(): Promise<void> {
  // Modern fake timers stub the channel React uses to flush a render, so a
  // create() under them returns before Capture runs and the provider looks
  // unmounted. Render on the real clock, then hand the poll to the fake one.
  jest.useRealTimers();
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(GatewayProvider, null, React.createElement(Capture)),
    );
  });
  for (let index = 0; index < 20; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  jest.useFakeTimers();
  // The bootstrap reads storage, the roster and the device identity in a chain
  // of promises; give every link a turn before anyone counts a timer.
  await settle(12);
}

/**
 * The typed-address, blank-key path: it identifies, files the first access
 * request, and parks the provider in pairing recovery. That is the state the
 * poll below belongs to.
 */
async function beginPairing(): Promise<void> {
  await mount();
  await act(async () => {
    const pending = gatewayApi().setupFromPcAddress(GATE_HOST);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    await pending;
  });
  await settle();
  if (!gatewayApi().pairingDetails) throw new Error('the provider did not enter pairing recovery');
  // The poll keys its status read on the phone's device id: without it the
  // provider skips the read entirely and this file would be testing nothing.
  if (gatewayApi().deviceId !== 'device-under-test') {
    throw new Error(`the phone has no device identity yet (${String(gatewayApi().deviceId)})`);
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  (globalThis as { fetch: unknown }).fetch = gateFetch as unknown as typeof fetch;
  mockAccessCalls.length = 0;
  mockStatusReads.length = 0;
  mockClients.length = 0;
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.settings = {
    autoConnect: false,
    onboardingComplete: true,
    voiceEngine: 'auto',
    tailscaleHost: 'my-pc.tail1234.ts.net',
  };
  mockState.statusBody = { status: 'denied' };
  mockState.statusThrows = false;
  mockState.setupAccess = { status: 'pending-approval', requestId: 'req-1' };
  mockState.accessResult = { status: 'denied', reason: 'device grant revoked' };
  observed.gateway = null;
  observed.chat = null;
  gateFetch.mockClear();
  jest.mocked(upsertGateway).mockClear();
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

describe('VS-156: a Deny on the PC pair page sticks', () => {
  test('a denied status read files one access request, then stops for good', async () => {
    await beginPairing();
    // One request so far: the one `setupFromPcAddress` filed to park here.
    expect(mockAccessCalls).toHaveLength(1);

    await advance(3_000);

    // The status read answered `denied`, so the poll asked the Gate once —
    // and the Gate refused once more.
    expect(mockStatusReads).toHaveLength(1);
    expect(mockStatusReads[0]).toContain(`deviceId=device-under-test`);
    expect(mockAccessCalls).toHaveLength(2);

    // Two more ticks. Nothing may be re-filed, and there is nothing left to
    // read: the denial ends this effect's run.
    await advance(3_000);
    await advance(3_000);
    expect(mockAccessCalls).toHaveLength(2);
    expect(mockStatusReads).toHaveLength(1);
  });

  test('the denied hint stays on screen and names what the Gate refused', async () => {
    await beginPairing();
    await advance(3_000);

    const details = gatewayApi().pairingDetails;
    expect(details).not.toBeNull();
    expect(details?.reason).toBe('not-paired');
    expect(details?.remediationHint).toContain('device grant revoked');
    expect(details?.remediationHint).toContain('node gate/cli.mjs pair list');
  });

  test('a pending status keeps polling at 3 s, and files no access request', async () => {
    mockState.statusBody = { status: 'pending', requestId: 'req-7' };
    await beginPairing();

    // Three intervals, because three ticks of the 3 s timer are due.
    await advance(3_000);
    await advance(3_000);
    await advance(3_000);

    expect(mockStatusReads).toHaveLength(3);
    // Waiting is not asking again: the one signed request is still the setup's.
    expect(mockAccessCalls).toHaveLength(1);
    // The Gate's own requestId replaced the setup's, so approval can be named.
    expect(gatewayApi().pairingDetails?.requestId).toBe('req-7');
  });

  test('a granted status ends pairing and stops polling', async () => {
    mockState.statusBody = { status: 'approved' };
    mockState.accessResult = { status: 'granted', token: 'dev-token' };
    await beginPairing();

    await advance(3_000);

    // The issued device token was saved onto the same Gate profile, and pairing
    // ended. This fixture does not build a live client (the attach bails before
    // createClientForKind); what the poll owns is that a grant is terminal.
    expect(jest.mocked(upsertGateway)).toHaveBeenCalledWith(
      expect.objectContaining({ url: GATE_URL, token: 'dev-token' }),
    );
    expect(gatewayApi().pairingDetails).toBeNull();
    expect(mockAccessCalls).toHaveLength(2);

    // A grant is terminal: no tick re-reads the status or re-asks.
    await advance(9_000);
    expect(mockAccessCalls).toHaveLength(2);
    expect(mockStatusReads).toHaveLength(1);
  });

  test('a status read that never answers keeps polling', async () => {
    mockState.statusThrows = true;
    await beginPairing();
    expect(mockStatusReads).toHaveLength(0);

    await advance(3_000);
    await advance(3_000);
    await advance(3_000);

    // A transient failure is not a verdict: the poll keeps its own 3 s beat
    // and never files an access request off the back of it.
    expect(mockStatusReads).toHaveLength(3);
    expect(mockAccessCalls).toHaveLength(1);
    expect(gatewayApi().pairingDetails?.reason).toBe('not-paired');
  });
});
