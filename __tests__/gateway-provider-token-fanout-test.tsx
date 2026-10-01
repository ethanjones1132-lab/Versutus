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
import { addGatewayProfile, loadGateways, saveGateways } from '@/lib/gateway/storage';
import { probeGatewayCandidates } from '@/lib/gateway/probe';
import { resetHostLookupMemoryForTests } from '@/lib/gateway/host-lookup';
import { keyValueStorage } from '@/lib/storage/key-value';
import type { GatewayProfile } from '@/lib/gateway/types';
import type { GatewayManifest } from '@/lib/portal/manifest';

// AUTH-1, the whole chain: the live Gate logged bursts of
//   auth refused: GET /v1/sessions from <the phone's tailnet IP> - no authorization header
// in the exact shape of a connect fan-out. The saved Gate's own probe misses on
// a Tailscale blip, the wave reaches the same Gate under the tailnet IP the Gate
// itself advertises, and that winner was matched to a saved profile by exact URL
// only — so it became a NEW profile created with no token, and its client then
// sent the whole fan-out with no Authorization at all. This file drives the
// provider through that cycle with a recording fetch and asserts what the Gate
// would have seen.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

const GATE_DNS_URL = 'http://ethanspc.tail1234.ts.net:8760';
const GATE_TAILNET_IP = '100.95.137.83';
const GATE_TAILNET_URL = `http://${GATE_TAILNET_IP}:8760`;

const mockState = {
  gateways: [] as GatewayProfile[],
  activeId: null as string | null,
  /** Every id the app has made the active gateway, in order. */
  activeIdLog: [] as (string | null)[],
  settings: {
    autoConnect: true,
    onboardingComplete: true,
    voiceEngine: 'auto',
    tailscaleHost: 'ethanspc.tail1234.ts.net',
  } as Record<string, unknown>,
  /** URLs the single-URL probe answers 404/unreachable for — a DNS blip. */
  unreachableUrls: new Set<string>(),
  /** The URL the candidate wave answers for, or null when nothing answers. */
  waveWinner: null as string | null,
  /** Hosts whose name misses, the way a MagicDNS blip does on the phone. */
  dnsMissHosts: new Set<string>(),
  /** Whether the well-known document is fetched for real (or stubbed away). */
  serveWellKnown: false,
  /** The document the well-known route answers, or the Gate's own when null. */
  wellKnownManifest: null as GatewayManifest | null,
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
    mockState.activeId = id;
    mockState.activeIdLog.push(id);
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
  probeGatewayCandidates: jest.fn(async () =>
    mockState.waveWinner
      ? { ok: true, url: mockState.waveWinner }
      : { ok: false, url: '', error: 'Network request failed' },
  ),
  probeGatewayUrl: jest.fn(async (url: string) =>
    mockState.unreachableUrls.has(url)
      ? { ok: false, url, error: 'Network request failed' }
      : { ok: true, url },
  ),
  probeHighPriorityCandidates: jest.fn(async () => null),
}));

jest.mock('@/lib/portal/manifest', () => {
  const actual = jest.requireActual<typeof import('@/lib/portal/manifest')>('@/lib/portal/manifest');
  return {
    ...actual,
    // Stubbed away by default so a test that is not about identification does
    // not carry the well-known request; the manifest tests turn it back on.
    fetchGatewayManifestWithLookupRetry: jest.fn(async (baseUrl: string, alternateIpv4: string[]) =>
      mockState.serveWellKnown ? actual.fetchGatewayManifestWithLookupRetry(baseUrl, alternateIpv4) : null,
    ),
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
  // The tailnet IPv4 this phone can reach that Gate on.
  transport: { ipv4: [GATE_TAILNET_IP] },
} as unknown as GatewayManifest;

const WELL_KNOWN_PATH = '/.well-known/gateway.json';
const GATE_DNS_HOST = 'ethanspc.tail1234.ts.net';

type RecordedRequest = { method: string; url: string; authorization?: string };

/** Everything a built client asked the gateway for, headers included. */
let requests: RecordedRequest[] = [];
/** Whether the gateway refuses an authenticated route that carries no key. */
let refuseWithoutKey = true;

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
 * A name that will not resolve, shaped the way the platform reports one: the
 * fetch rejects with `TypeError: fetch failed` and the resolver's signal hangs
 * off `cause`. This is the signal every request retries an advertised IPv4 on.
 */
function dnsMiss(host: string): Error {
  const error = new TypeError('fetch failed');
  (error as { cause?: unknown }).cause = { code: 'ENOTFOUND', message: `getaddrinfo ENOTFOUND ${host}` };
  return error;
}

/**
 * The Gate's own answer: `/health` and the well-known document are public, and
 * every `/v1/*` route wants the bearer token and answers 401 without one.
 */
const gateFetch = jest.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const authorization = headerValue(init, 'authorization');
  requests.push({ method: init?.method ?? 'GET', url, authorization });
  const body = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const host = (url.split('/')[2] ?? '').split(':')[0];
  if (mockState.dnsMissHosts.has(host)) throw dnsMiss(host);
  if (url.includes(WELL_KNOWN_PATH)) return body(mockState.wellKnownManifest ?? GATE_MANIFEST);
  if (url.endsWith('/health')) return body({ status: 'ok', platform: 'win32', version: '0.18.0' });
  if (refuseWithoutKey && !authorization) {
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

/** The requests that reached the gateway at all — a name that missed sends none. */
function deliveredRequests(): RecordedRequest[] {
  return authenticatedRequests().filter((request) => !mockState.dnsMissHosts.has((request.url.split('/')[2] ?? '').split(':')[0]));
}

function profile(overrides: Partial<GatewayProfile> & { id: string; url: string }): GatewayProfile {
  return {
    name: overrides.id,
    kind: 'custom',
    token: 't',
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
      <GatewayProvider>
        <Capture />
      </GatewayProvider>,
    );
  });
  await settle(4, 0);
}

beforeEach(async () => {
  // The manifest cache is this device's real key-value storage, and this file
  // writes to it: a test that means the LIVE path must not inherit a document.
  for (const id of ['alpha', 'beta', 'gamma', 'twin']) {
    await keyValueStorage.removeItem(gateManifestCacheKey(id));
  }
  jest.useFakeTimers();
  // A hostname that missed for one test must not make the next test try its
  // advertised IPv4 first.
  resetHostLookupMemoryForTests();
  (globalThis as { fetch: unknown }).fetch = gateFetch as unknown as typeof fetch;
  requests = [];
  refuseWithoutKey = true;
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.activeIdLog = [];
  mockState.settings = {
    autoConnect: true,
    onboardingComplete: true,
    voiceEngine: 'auto',
    tailscaleHost: 'ethanspc.tail1234.ts.net',
  };
  mockState.unreachableUrls = new Set();
  mockState.waveWinner = null;
  mockState.dnsMissHosts = new Set();
  mockState.serveWellKnown = false;
  mockState.wellKnownManifest = null;
  observed.gateway = null;
  observed.chat = null;
  jest.mocked(probeGatewayCandidates).mockClear();
  jest.mocked(addGatewayProfile).mockClear();
  jest.mocked(saveGateways).mockClear();
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

describe('a saved Gate the wave reaches under another host form', () => {
  test('its fan-out carries the saved token, and the saved URL does not move', async () => {
    const alpha = profile({ id: 'alpha', url: GATE_DNS_URL, token: 't' });
    mockState.gateways = [alpha];
    mockState.activeId = alpha.id;
    // The MagicDNS name is in a blip — the probe cannot resolve it and no
    // request can either — while the tailnet IP the Gate itself advertises
    // answers, and that is what the candidate wave returns.
    mockState.unreachableUrls = new Set([GATE_DNS_URL]);
    mockState.dnsMissHosts = new Set([GATE_DNS_HOST]);
    mockState.waveWinner = GATE_TAILNET_URL;
    await saveCachedGateManifest(alpha.id, GATE_MANIFEST);

    await mount();
    await settle(8, 2_000);

    expect(jest.mocked(probeGatewayCandidates)).toHaveBeenCalled();
    // The winner was the tailnet IP, and the saved profile reached it there:
    // the name misses, so every request falls back to the advertised IPv4.
    const fanOut = deliveredRequests();
    expect(fanOut.some((request) => request.url.startsWith(GATE_TAILNET_URL))).toBe(true);
    // ...carrying the saved key on every one of them, the fan-out included.
    // Asserted before the status: the request that carried no key is the defect,
    // and the refused connect is only its consequence.
    expect(fanOut.some((request) => request.url.includes('/v1/'))).toBe(true);
    for (const request of fanOut) {
      expect(request.authorization).toBe('Bearer t');
    }
    expect(gatewayApi().status).toBe('connected');
    // The same Gate, reached the reachable way: the saved profile, still the one
    // that carries the token, and no second profile beside it.
    expect(gatewayApi().activeGateway?.id).toBe(alpha.id);
    expect(gatewayApi().activeGateway?.token).toBe('t');
    expect(gatewayApi().activeGateway?.url).toBe(GATE_DNS_URL);
    expect(jest.mocked(addGatewayProfile)).not.toHaveBeenCalled();
    const saved = await jest.mocked(loadGateways)();
    expect(saved.map((item) => item.id)).toEqual([alpha.id]);
    expect(saved[0].url).toBe(GATE_DNS_URL);
    // The address that answered is remembered as an alternate, not as the
    // operator's address: one lucky wave does not rewrite their gateway.
    expect(saved[0].alternateIpv4).toContain(GATE_TAILNET_IP);
  });

  test('a token-less copy the roster still holds does not win over the paired profile', async () => {
    // The twin this bug created, saved under the tailnet IP by an earlier wave
    // and left behind because two saved profiles can vouch for that address, so
    // no startup merge is safe. It is the ACTIVE gateway, which is how the
    // connect picked it in the first place.
    const alpha = profile({ id: 'alpha', url: GATE_DNS_URL, token: 't' });
    const twin = profile({ id: 'twin', url: GATE_TAILNET_URL, token: undefined, name: 'Ethanspc' });
    const office = profile({ id: 'office', url: 'http://office.tail1234.ts.net:8760', token: 't2', alternateIpv4: [GATE_TAILNET_IP] });
    mockState.gateways = [alpha, office, twin];
    mockState.activeId = twin.id;
    // The paired profile's name is in a blip, and so is the twin's own address
    // at the moment it is probed; the wave answers on the twin's URL all the same.
    mockState.unreachableUrls = new Set([GATE_DNS_URL, GATE_TAILNET_URL]);
    mockState.dnsMissHosts = new Set([GATE_DNS_HOST]);
    mockState.waveWinner = GATE_TAILNET_URL;
    await saveCachedGateManifest(alpha.id, GATE_MANIFEST);

    await mount();
    await settle(8, 2_000);

    expect(gatewayApi().status).toBe('connected');
    // The paired profile answered this wave's own URL, so the token-less copy
    // sitting on that exact URL cannot take the connect.
    expect(gatewayApi().activeGateway?.id).toBe(alpha.id);
    const fanOut = deliveredRequests();
    expect(fanOut.length).toBeGreaterThan(0);
    for (const request of fanOut) {
      expect(request.authorization).toBe('Bearer t');
    }
    expect(jest.mocked(addGatewayProfile)).not.toHaveBeenCalled();
    // No startup merge was safe here, so the twin is still in the roster — and
    // it was never made the active gateway, which is the whole point: the exact
    // URL it sits on loses to the profile that can authenticate.
    expect(jest.mocked(saveGateways)).not.toHaveBeenCalled();
    expect(mockState.activeIdLog).toEqual([alpha.id]);
    const saved = await jest.mocked(loadGateways)();
    expect(saved.find((item) => item.id === twin.id)?.token).toBeUndefined();
    expect(saved.find((item) => item.id === alpha.id)?.url).toBe(GATE_DNS_URL);
    expect(saved.find((item) => item.id === alpha.id)?.alternateIpv4).toContain(GATE_TAILNET_IP);
  });
});

describe('the roster a poisoned device is holding at startup', () => {
  test('is healed to one profile, active, with the key — before anything connects', async () => {
    const paired = profile({ id: 'alpha', url: GATE_DNS_URL, token: 't' });
    const twin = profile({ id: 'twin', name: 'Ethanspc', url: GATE_TAILNET_URL, token: undefined });
    mockState.gateways = [paired, twin];
    // The copy that cannot authenticate is the ACTIVE gateway, which is how the
    // operator's phone got here: the connect picked it, so the next wave does too.
    mockState.activeId = twin.id;
    mockState.settings = { ...mockState.settings, tailscaleHost: GATE_TAILNET_IP };
    await saveCachedGateManifest(paired.id, GATE_MANIFEST);

    await mount();
    await settle(8, 2_000);

    // One profile, the one with the key, written and made active.
    expect(jest.mocked(saveGateways)).toHaveBeenCalledTimes(1);
    const healed = jest.mocked(saveGateways).mock.calls[0][0];
    expect(healed.map((item) => item.id)).toEqual([paired.id]);
    expect(healed[0].token).toBe('t');
    expect(healed[0].url).toBe(GATE_DNS_URL);
    expect(mockState.activeId).toBe(paired.id);
    expect(gatewayApi().activeGateway?.id).toBe(paired.id);
    // And the connect that followed used it: the twin's address never ran a
    // fan-out, and every request carried the key.
    expect(requests.some((request) => request.url.startsWith(GATE_TAILNET_URL))).toBe(false);
    for (const request of authenticatedRequests()) {
      expect(request.authorization).toBe('Bearer t');
    }
  });

  test('is left byte-identical when there is nothing to heal', async () => {
    const paired = profile({ id: 'alpha', url: GATE_DNS_URL, token: 't' });
    mockState.gateways = [paired];
    mockState.activeId = paired.id;

    await mount();
    await settle(4);

    expect(jest.mocked(saveGateways)).not.toHaveBeenCalled();
    expect(gatewayApi().activeGateway?.id).toBe(paired.id);
  });
});

describe('a Gate profile with no token at all', () => {
  test('a profile saved as a Gate issues no request and never claims the key was refused', async () => {
    const beta = profile({ id: 'beta', url: GATE_TAILNET_URL, token: undefined });
    mockState.gateways = [beta];
    mockState.activeId = null;
    await saveCachedGateManifest(beta.id, GATE_MANIFEST);

    await mount();
    await act(async () => {
      await gatewayApi().connectGateway(beta);
    });
    await settle(4);

    // No request at all: this profile's manifest was cached, so even the public
    // well-known document was never asked for again.
    expect(requests).toEqual([]);
    // Nothing was ever sent without a key, so there is nothing for the Gate to
    // refuse and nothing for the app to blame a key for.
    expect(gatewayApi().status).not.toBe('connected');
    expect(gatewayApi().probeMessage).not.toMatch(/rejected the api key/i);
    expect(gatewayApi().lastError ?? '').not.toMatch(/rejected the api key/i);
    // It stops on the existing "needs a token" state instead — the wording the
    // Home empty state already reads to offer the setup action.
    expect(gatewayApi().lastError ?? '').toMatch(/token required/i);
    expect(gatewayApi().connectionPhase).toBe('failed');
  });

  test('a Gate saved without a key stops even when its document declares no auth', async () => {
    // The document answered here declares no bearer scheme, so the manifest
    // branch of the guard says "no key needed" — but the profile was SAVED as a
    // Gate, and a Gate that was paired once is a Gate that needs its key.
    mockState.wellKnownManifest = { ...GATE_MANIFEST, auth: undefined } as unknown as GatewayManifest;
    const delta = profile({ id: 'beta', url: GATE_TAILNET_URL, token: undefined });
    mockState.gateways = [delta];
    mockState.activeId = null;
    mockState.serveWellKnown = true;

    await mount();
    await act(async () => {
      await gatewayApi().connectGateway(delta);
    });
    await settle(4);

    // The one request an attach may make without a key is the well-known
    // document itself: it is public, it is how the app learns what this gateway
    // is, and it asks for nothing.
    expect(requests).toEqual([
      { method: 'GET', url: `${GATE_TAILNET_URL}${WELL_KNOWN_PATH}`, authorization: undefined },
    ]);
    expect(gatewayApi().status).not.toBe('connected');
    expect(gatewayApi().probeMessage).not.toMatch(/rejected the api key/i);
    expect(gatewayApi().lastError ?? '').toMatch(/token required/i);
    expect(gatewayApi().connectionPhase).toBe('failed');
  });

  test('a manifest that declares bearer stops the attach of a profile with no kind either', async () => {
    // Saved with no kind at all, which is how onboarding used to leave one — the
    // attach learns it is a Gate from the document itself.
    const delta = profile({ id: 'beta', url: GATE_TAILNET_URL, kind: undefined, token: undefined });
    mockState.gateways = [delta];
    mockState.activeId = null;
    mockState.serveWellKnown = true;

    await mount();
    await act(async () => {
      await gatewayApi().connectGateway(delta);
    });
    await settle(4);

    expect(requests).toEqual([
      { method: 'GET', url: `${GATE_TAILNET_URL}${WELL_KNOWN_PATH}`, authorization: undefined },
    ]);
    expect(gatewayApi().status).not.toBe('connected');
    expect(gatewayApi().probeMessage).not.toMatch(/rejected the api key/i);
    expect(gatewayApi().lastError ?? '').toMatch(/token required/i);
    expect(gatewayApi().connectionPhase).toBe('failed');
  });

  test("a twin of a Gate this device is paired with connects the paired profile", async () => {
    const alpha = profile({ id: 'alpha', url: GATE_DNS_URL, token: 't' });
    const twin = profile({ id: 'twin', url: GATE_TAILNET_URL, token: undefined, name: 'Ethanspc' });
    mockState.gateways = [alpha, twin];
    // The poisoned copy is the active gateway, which is how the startup repair
    // found it on the operator's phone — and this attach must not be a dead end.
    // Startup's auto-connect is what attaches it, so nothing awaits the connect.
    mockState.activeId = twin.id;
    mockState.dnsMissHosts = new Set([GATE_DNS_HOST]);
    await saveCachedGateManifest(alpha.id, GATE_MANIFEST);

    await mount();
    await settle(12, 1_000);

    expect(gatewayApi().status).toBe('connected');
    expect(gatewayApi().activeGateway?.id).toBe(alpha.id);
    const fanOut = deliveredRequests();
    expect(fanOut.some((request) => request.url.startsWith(GATE_TAILNET_URL))).toBe(true);
    for (const request of fanOut) {
      expect(request.authorization).toBe('Bearer t');
    }
  });
});

describe('a bare Hermes that legitimately has no token', () => {
  test('still connects, and still sends no Authorization header', async () => {
    const gamma = profile({ id: 'gamma', url: 'http://hermes.test:8642', kind: 'hermes', token: undefined });
    mockState.gateways = [gamma];
    mockState.activeId = null;
    refuseWithoutKey = false;

    await mount();
    await act(async () => {
      await gatewayApi().connectGateway(gamma);
    });
    await settle(8, 2_000);

    expect(gatewayApi().status).toBe('connected');
    const fanOut = authenticatedRequests();
    expect(fanOut.length).toBeGreaterThan(0);
    for (const request of fanOut) {
      expect(request.authorization).toBeUndefined();
    }
  });
});
