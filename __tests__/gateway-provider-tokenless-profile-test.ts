import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import {
  GatewayProvider,
  useChatSurface,
  useGateway,
  type ChatSurfaceContextValue,
  type GatewayContextValue,
} from '@/context/gateway-provider';
import { gateManifestCacheKey, saveCachedGateManifest } from '@/lib/portal/attach-manifest';
import { loadGateways, upsertGateway } from '@/lib/gateway/storage';
import { probeGatewayCandidates, probeHighPriorityCandidates } from '@/lib/gateway/probe';
import { resetHostLookupMemoryForTests } from '@/lib/gateway/host-lookup';
import { keyValueStorage } from '@/lib/storage/key-value';
import type { GatewayProfile } from '@/lib/gateway/types';
import type { GatewayManifest } from '@/lib/portal/manifest';

// VS-041: a saved profile sitting on the exact URL a connect reaches, with no
// token of its own, while the operator retypes the key. The early branch used
// to return that token-less copy as-is, so the typed key never reached the
// profile and every retry attached anonymously — the Gate answered 401 and the
// operator could retry forever without ever connecting. These tests drive the
// real provider through `setupFromPcAddress` (the typed address + key path) and
// assert what was persisted and what the connect carried.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

const GATE_URL = 'http://my-pc.tail1234.ts.net:8760';
/** The same address the way the operator types it: no scheme. */
const GATE_HOST = 'my-pc.tail1234.ts.net:8760';
const OTHER_TOKEN = 'old';
const TYPED_TOKEN = 'typed';

const mockState = {
  gateways: [] as GatewayProfile[],
  activeId: null as string | null,
  settings: {
    autoConnect: false,
    onboardingComplete: true,
    voiceEngine: 'auto',
    tailscaleHost: 'my-pc.tail1234.ts.net',
  } as Record<string, unknown>,
  /** The URL the candidate wave answers for. */
  waveWinner: GATE_URL as string | null,
  /** Hold one automatic probe open so explicit setup can supersede it. */
  deferredProbeUrl: null as string | null,
  waitForDeferredProbe: null as (() => Promise<void>) | null,
  /** Hold a cold connect at its saved-pin write or first Gate request. */
  deferredActiveSaveId: null as string | null,
  waitForDeferredActiveSave: null as (() => Promise<void>) | null,
  deferredActiveSaveStarted: false,
  deferredFetchUrl: null as string | null,
  deferredFetchPath: null as string | null,
  waitForDeferredFetch: null as (() => Promise<void>) | null,
  deferredFetchStarted: false,
};

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
    if (id && id === mockState.deferredActiveSaveId) {
      mockState.deferredActiveSaveStarted = true;
      await mockState.waitForDeferredActiveSave?.();
    }
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
  probeGatewayCandidates: jest.fn(async (urls: string[]) => {
    const winner = urls.find((url) => url === mockState.waveWinner);
    return winner
      ? { ok: true, url: winner, latencyMs: 0, hasManifest: true }
      : { ok: false, url: urls[0] ?? '', error: 'Network request failed', code: 'unreachable' as const };
  }),
  probeGatewayUrl: jest.fn(async (url: string) => ({ ok: true, url })),
  probeHighPriorityCandidates: jest.fn(async (urls: string[]) => {
    if (mockState.deferredProbeUrl && urls.includes(mockState.deferredProbeUrl)) {
      await mockState.waitForDeferredProbe?.();
    }
    const winner = urls.find((url) => url === mockState.waveWinner);
    return winner ? { ok: true, url: winner, latencyMs: 0, hasManifest: true } : null;
  }),
}));

jest.mock('@/lib/portal/manifest', () => {
  const actual = jest.requireActual<typeof import('@/lib/portal/manifest')>('@/lib/portal/manifest');
  return {
    ...actual,
    // This file does not test identification: the saved profile carries its
    // own cached manifest, so no well-known request is needed or wanted.
    fetchGatewayManifestWithLookupRetry: jest.fn(async () => null),
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

/** The Gate's own document, as gate/core/manifest.mjs writes it. */
const GATE_MANIFEST = {
  manifest: 'versutus-gateway/v1',
  kind: 'versutus-gate',
  name: 'Versutus Gate',
  version: '1.0.0',
  endpoints: {
    health: '/health',
    models: '/v1/models',
    sessions: '/v1/sessions',
    environments: '/v1/environments',
    providers: '/v1/providers',
    bots: '/v1/bots',
    capabilitiesRpc: '/v1/capabilities/rpc',
    chat: '/v1/chat/completions',
  },
  auth: { grantPath: '/.well-known/gateway/access', schemes: ['bearer'] },
} as unknown as GatewayManifest;

const WELL_KNOWN_PATH = '/.well-known/gateway.json';

type RecordedRequest = { method: string; url: string; authorization?: string };

/** Everything a built client asked the gateway for, headers included. */
let requests: RecordedRequest[] = [];

function headerValue(init: unknown, name: string): string | undefined {
  const headers = (init as { headers?: Record<string, string> } | undefined)?.headers;
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * The Gate's own answer: `/health` and the well-known document are public, and
 * every `/v1/*` route wants the bearer token and answers 401 without one.
 */
const gateFetch = jest.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (
    mockState.deferredFetchUrl &&
    url.startsWith(mockState.deferredFetchUrl) &&
    mockState.deferredFetchPath &&
    url.endsWith(mockState.deferredFetchPath)
  ) {
    mockState.deferredFetchStarted = true;
    await mockState.waitForDeferredFetch?.();
  }
  const authorization = headerValue(init, 'authorization');
  requests.push({ method: init?.method ?? 'GET', url, authorization });
  const body = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.includes(WELL_KNOWN_PATH)) return body(GATE_MANIFEST);
  if (url.endsWith('/health')) return body({ status: 'ok', platform: 'win32', version: '0.18.0' });
  if (!authorization) {
    return new Response(JSON.stringify({ error: 'Unauthorized', message: 'Bearer token required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return body({ data: [] });
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

/** Every request except the public well-known document: the fan-out itself. */
function authenticatedRequests(): RecordedRequest[] {
  return requests.filter((request) => !request.url.includes(WELL_KNOWN_PATH));
}

function profile(overrides: Partial<GatewayProfile> & { id: string; url: string }): GatewayProfile {
  return {
    name: overrides.id,
    kind: 'custom',
    createdAt: 0,
    ...overrides,
  } as GatewayProfile;
}

let renderer: TestRenderer.ReactTestRenderer | null = null;

async function settle(rounds = 8, ms = 1): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(GatewayProvider, null, React.createElement(Capture)),
    );
  });
  await settle(4, 0);
}

/** The typed address + key path the operator's retry uses. */
async function setupFromPcAddress(pcAddress: string, token?: string): Promise<void> {
  await act(async () => {
    const pending = gatewayApi().setupFromPcAddress(pcAddress, token);
    // Let the real provider enter the explicit probe before awaiting completion.
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    await pending;
  });
  await settle(8, 1_000);
}

const SAVED_IDS = ['solo', 'stored', 'untouched'];

beforeEach(async () => {
  for (const id of SAVED_IDS) {
    await keyValueStorage.removeItem(gateManifestCacheKey(id));
  }
  jest.useFakeTimers();
  resetHostLookupMemoryForTests();
  (globalThis as { fetch: unknown }).fetch = gateFetch as unknown as typeof fetch;
  requests = [];
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.settings = {
    autoConnect: false,
    onboardingComplete: true,
    voiceEngine: 'auto',
    tailscaleHost: 'my-pc.tail1234.ts.net',
  };
  mockState.waveWinner = GATE_URL;
  mockState.deferredProbeUrl = null;
  mockState.waitForDeferredProbe = null;
  mockState.deferredActiveSaveId = null;
  mockState.waitForDeferredActiveSave = null;
  mockState.deferredActiveSaveStarted = false;
  mockState.deferredFetchUrl = null;
  mockState.deferredFetchPath = null;
  mockState.waitForDeferredFetch = null;
  mockState.deferredFetchStarted = false;
  observed.gateway = null;
  observed.chat = null;
  jest.mocked(probeGatewayCandidates).mockClear();
  jest.mocked(probeHighPriorityCandidates).mockClear();
  jest.mocked(upsertGateway).mockClear();
  jest.mocked(loadGateways).mockClear();
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

describe('a saved profile at the exact URL with no token', () => {
  test('a token supplied by the caller is persisted on it and used by the connect', async () => {
    const solo = profile({ id: 'solo', url: GATE_URL, token: undefined });
    mockState.gateways = [solo];
    mockState.activeId = solo.id;
    await saveCachedGateManifest(solo.id, GATE_MANIFEST);

    await mount();
    await setupFromPcAddress(GATE_HOST, TYPED_TOKEN);

    // The key the operator typed was written onto the saved profile, not
    // discarded in favour of the token-less copy.
    expect(jest.mocked(upsertGateway)).toHaveBeenCalledWith(
      expect.objectContaining({ id: solo.id, url: GATE_URL, token: TYPED_TOKEN }),
    );
    const saved = await jest.mocked(loadGateways)();
    expect(saved.find((item) => item.id === solo.id)?.token).toBe(TYPED_TOKEN);
    expect(gatewayApi().gateways.find((item) => item.id === solo.id)?.token).toBe(TYPED_TOKEN);
    expect(gatewayApi().activeGateway?.id).toBe(solo.id);
    expect(gatewayApi().activeGateway?.token).toBe(TYPED_TOKEN);

    // And the connect that followed carried it, so the Gate did not refuse an
    // anonymous fan-out. Without the fix this profile attaches token-less and
    // stops on "token required" with no request at all.
    expect(gatewayApi().status).toBe('connected');
    expect(mockState.settings.manualSetupPending).toBe(false);
    const fanOut = authenticatedRequests();
    expect(fanOut.some((request) => request.url.includes('/v1/'))).toBe(true);
    for (const request of fanOut) {
      expect(request.authorization).toBe(`Bearer ${TYPED_TOKEN}`);
    }
  });

  test('with no token supplied the saved profile comes back unchanged', async () => {
    const untouched = profile({ id: 'untouched', url: GATE_URL, token: undefined });
    mockState.gateways = [untouched];
    mockState.activeId = untouched.id;
    await saveCachedGateManifest(untouched.id, GATE_MANIFEST);

    await mount();
    await setupFromPcAddress(GATE_HOST);

    // Nothing invented a token, and nothing was rewritten.
    expect(jest.mocked(upsertGateway)).not.toHaveBeenCalled();
    const saved = await jest.mocked(loadGateways)();
    expect(saved.find((item) => item.id === untouched.id)?.token).toBeUndefined();
    expect(gatewayApi().gateways.find((item) => item.id === untouched.id)?.token).toBeUndefined();
    expect(gatewayApi().activeGateway?.id).toBe(untouched.id);
    expect(gatewayApi().activeGateway?.token).toBeUndefined();
    // A Gate with no key still stops at the existing "needs a token" state
    // instead of attaching anonymously.
    expect(gatewayApi().status).not.toBe('connected');
    expect(gatewayApi().lastError ?? '').toMatch(/token required/i);
    expect(mockState.settings.manualSetupPending).toBe(true);
  });
});

describe('a saved profile at the exact URL that already has a token', () => {
  test('a different supplied token still follows the replace path', async () => {
    const stored = profile({ id: 'stored', url: GATE_URL, token: OTHER_TOKEN });
    mockState.gateways = [stored];
    mockState.activeId = stored.id;
    await saveCachedGateManifest(stored.id, GATE_MANIFEST);

    await mount();
    await setupFromPcAddress(GATE_HOST, TYPED_TOKEN);

    expect(jest.mocked(upsertGateway)).toHaveBeenCalledWith(
      expect.objectContaining({ id: stored.id, url: GATE_URL, token: TYPED_TOKEN }),
    );
    const saved = await jest.mocked(loadGateways)();
    expect(saved.find((item) => item.id === stored.id)?.token).toBe(TYPED_TOKEN);
    expect(gatewayApi().activeGateway?.id).toBe(stored.id);
    expect(gatewayApi().activeGateway?.token).toBe(TYPED_TOKEN);

    expect(gatewayApi().status).toBe('connected');
    expect(mockState.settings.manualSetupPending).toBe(false);
    const fanOut = authenticatedRequests();
    expect(fanOut.length).toBeGreaterThan(0);
    for (const request of fanOut) {
      expect(request.authorization).toBe(`Bearer ${TYPED_TOKEN}`);
    }
  });
});

describe('manual setup stays on the address the operator entered', () => {
  test('a different responsive saved Gate is not tried and never receives the typed key', async () => {
    const otherUrl = 'http://other-pc.tail1234.ts.net:8760';
    const other = profile({ id: 'other-pc', url: otherUrl, token: undefined });
    mockState.gateways = [other];
    mockState.activeId = other.id;
    mockState.waveWinner = otherUrl;
    await saveCachedGateManifest(other.id, GATE_MANIFEST);

    await mount();
    await setupFromPcAddress(GATE_HOST, TYPED_TOKEN);

    const manualCandidates = [
      ...jest.mocked(probeHighPriorityCandidates).mock.calls.flatMap(([urls]) => urls),
      ...jest.mocked(probeGatewayCandidates).mock.calls.flatMap(([urls]) => urls),
    ];
    expect(manualCandidates).not.toContain(otherUrl);
    expect(gatewayApi().status).not.toBe('connected');
    expect(requests.some((request) => request.url.startsWith(otherUrl))).toBe(false);
    expect(authenticatedRequests()).toHaveLength(0);
    expect(mockState.settings.manualSetupPending).toBe(true);
    expect(jest.mocked(upsertGateway)).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: other.id, token: TYPED_TOKEN }),
    );

    const callsBeforeAutoRetry = jest.mocked(probeHighPriorityCandidates).mock.calls.length;
    await act(async () => {
      await gatewayApi().retryAutoConnect();
    });
    await settle(4, 0);

    expect(jest.mocked(probeHighPriorityCandidates)).toHaveBeenCalledTimes(callsBeforeAutoRetry);
    expect(gatewayApi().status).not.toBe('connected');
    expect(requests.some((request) => request.url.startsWith(otherUrl))).toBe(false);
  });

  test('an older auto-connect result cannot connect its saved Gate over a successful explicit choice', async () => {
    const otherUrl = 'http://other-pc.tail1234.ts.net:8760';
    const other = profile({ id: 'other-pc', url: otherUrl, token: OTHER_TOKEN });
    mockState.gateways = [other];
    mockState.activeId = other.id;
    mockState.waveWinner = otherUrl;
    mockState.settings = {
      autoConnect: true,
      onboardingComplete: false,
      voiceEngine: 'auto',
      tailscaleHost: 'other-pc.tail1234.ts.net',
      lastSuccessfulUrl: otherUrl,
    };
    let releaseProbe!: () => void;
    const heldProbe = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    mockState.deferredProbeUrl = otherUrl;
    mockState.waitForDeferredProbe = () => heldProbe;
    await saveCachedGateManifest(other.id, GATE_MANIFEST);

    await mount();
    expect(jest.mocked(probeHighPriorityCandidates)).toHaveBeenCalledWith(
      [otherUrl],
      expect.any(Function),
      expect.any(Number),
    );

    mockState.waveWinner = GATE_URL;
    await setupFromPcAddress(GATE_HOST, TYPED_TOKEN);
    expect(gatewayApi().activeGateway?.url).toBe(GATE_URL);
    expect(gatewayApi().status).toBe('connected');

    releaseProbe();
    await settle(8, 1_000);

    expect(gatewayApi().activeGateway?.url).toBe(GATE_URL);
    expect(gatewayApi().status).toBe('connected');
    expect(requests.some((request) => request.url.startsWith(otherUrl))).toBe(false);
  });

  test('an automatic connect awaiting its pin write cannot attach after manual setup fails', async () => {
    const savedUrl = GATE_URL;
    const saved = profile({ id: 'solo', url: savedUrl, token: OTHER_TOKEN });
    mockState.gateways = [saved];
    mockState.activeId = null;
    mockState.waveWinner = savedUrl;
    mockState.deferredActiveSaveId = saved.id;
    mockState.settings = {
      autoConnect: true,
      onboardingComplete: false,
      voiceEngine: 'auto',
      tailscaleHost: 'my-pc.tail1234.ts.net',
      lastSuccessfulUrl: savedUrl,
    };
    let releasePinWrite!: () => void;
    const heldPinWrite = new Promise<void>((resolve) => {
      releasePinWrite = resolve;
    });
    mockState.waitForDeferredActiveSave = () => heldPinWrite;
    await saveCachedGateManifest(saved.id, GATE_MANIFEST);

    await mount();
    await settle(12, 0);
    expect(mockState.deferredActiveSaveStarted).toBe(true);

    mockState.waveWinner = null;
    try {
      await setupFromPcAddress('different-pc.tail1234.ts.net:8760', TYPED_TOKEN);
    } finally {
      releasePinWrite();
    }
    await settle(12, 1_000);

    expect(gatewayApi().status).not.toBe('connected');
    expect(gatewayApi().activeGateway).toBeNull();
    expect(mockState.activeId).toBeNull();
    expect(requests.some((request) => request.url.startsWith(savedUrl))).toBe(false);
  });

  test('manual setup tears down an automatic client already waiting on its Gate', async () => {
    const savedUrl = GATE_URL;
    const saved = profile({ id: 'solo', url: savedUrl, token: OTHER_TOKEN });
    mockState.gateways = [saved];
    mockState.activeId = saved.id;
    mockState.waveWinner = savedUrl;
    mockState.deferredFetchUrl = savedUrl;
    mockState.deferredFetchPath = '/health';
    mockState.settings = {
      autoConnect: true,
      onboardingComplete: false,
      voiceEngine: 'auto',
      tailscaleHost: 'my-pc.tail1234.ts.net',
      lastSuccessfulUrl: savedUrl,
    };
    let releaseFetch!: () => void;
    const heldFetch = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    mockState.waitForDeferredFetch = () => heldFetch;
    await saveCachedGateManifest(saved.id, GATE_MANIFEST);

    await mount();
    await settle(12, 0);
    expect(mockState.deferredFetchStarted).toBe(true);

    mockState.waveWinner = null;
    try {
      await setupFromPcAddress('different-pc.tail1234.ts.net:8760', TYPED_TOKEN);
    } finally {
      releaseFetch();
    }
    await settle(12, 1_000);

    expect(gatewayApi().status).not.toBe('connected');
    expect(gatewayApi().activeGateway?.id).toBe(saved.id);
    expect(mockState.activeId).toBe(saved.id);
  });

  test('a restarted pending explicit setup does not auto-connect a different saved Gate', async () => {
    const otherUrl = 'http://other-pc.tail1234.ts.net:8760';
    const other = profile({ id: 'other-pc', url: otherUrl, token: OTHER_TOKEN });
    mockState.gateways = [other];
    mockState.activeId = other.id;
    mockState.waveWinner = otherUrl;
    mockState.settings = {
      autoConnect: true,
      onboardingComplete: false,
      manualSetupPending: true,
      voiceEngine: 'auto',
      tailscaleHost: 'typed-pc.tail1234.ts.net',
      lastSuccessfulUrl: otherUrl,
    };

    await mount();
    await settle(4, 0);

    expect(gatewayApi().needsOnboarding).toBe(true);
    expect(jest.mocked(probeHighPriorityCandidates)).not.toHaveBeenCalled();
    expect(jest.mocked(probeGatewayCandidates)).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    expect(gatewayApi().status).not.toBe('connected');
  });
});
