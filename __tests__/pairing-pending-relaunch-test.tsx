/**
 * VS-157 — a phone waiting for the PC's approval stays in pairing across a
 * relaunch.
 *
 * The Gate queues a phone that asked to pair, and the first run saved a
 * token-less gateway profile and marked onboarding complete in the same breath.
 * Relaunching mid-pairing therefore landed on Chat with "pair it again" instead
 * of the approve instructions, and onboarding claimed to be finished before the
 * device token the Gate issues on approval existed.
 *
 * These tests mount the real provider with the real onboarding screen: the
 * first session asks to pair and is queued, the second session is the relaunch.
 * On the pre-VS-157 settlement the first session sets onboardingComplete and
 * the relaunch never renders the approve state.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, top: 0, left: 0, right: 0 }),
  SafeAreaView: 'SafeAreaView',
}));

jest.mock('react-native-reanimated', () => {
  const builder = () => {
    const chain = {
      duration: () => chain,
      easing: () => chain,
      delay: () => chain,
      withInitialValues: () => chain,
    };
    return chain;
  };
  return {
    Easing: {
      bezier: () => (value: number) => value,
      elastic: () => (value: number) => value,
      ease: (value: number) => value,
      inOut: (fn: unknown) => fn,
      quad: (fn: unknown) => fn,
      sin: (fn: unknown) => fn,
    },
    FadeIn: builder(),
    FadeInDown: builder(),
    FadeOut: builder(),
    Layout: { duration: () => undefined },
    useAnimatedStyle: () => ({}),
    useSharedValue: (value: unknown) => ({ value }),
    withRepeat: () => undefined,
    withTiming: () => undefined,
    __esModule: true,
    default: { View: 'AnimatedView' },
  };
});

jest.mock('@/components/brand', () => ({ VersutusLogotype: 'VersutusLogotype' }));
jest.mock('@/components/device-id-row', () => ({ DeviceIdRow: 'DeviceIdRow' }));
jest.mock('@/components/connection-timeline', () => ({
  ConnectionTimeline: 'ConnectionTimeline',
  CONNECTION_TIMELINE_STEPS_LONG: [],
}));
// The kit primitives are host components, so their props are the screen's real
// output: a Text keeps its string, a Button keeps its label.
jest.mock('@/components/ui', () => ({
  Button: 'Button',
  Card: 'Card',
  ErrorCard: 'ErrorCard',
  PressableScale: 'PressableScale',
  Screen: 'Screen',
  Text: 'Text',
  TextField: 'TextField',
}));

jest.mock('@/lib/haptics', () => ({
  haptics: {
    selection: jest.fn(async () => undefined),
    light: jest.fn(async () => undefined),
    medium: jest.fn(async () => undefined),
    success: jest.fn(async () => undefined),
    warning: jest.fn(async () => undefined),
    error: jest.fn(async () => undefined),
  },
}));

const mockState = {
  gateways: [] as GatewayProfile[],
  activeId: null as string | null,
  settings: {
    autoConnect: false,
    onboardingComplete: false,
    voiceEngine: 'auto',
  } as Record<string, unknown>,
  /** What the Gate's signed access endpoint answers. */
  access: 'pending' as 'pending' | 'granted',
  /** The token the Gate issues on approval (short on purpose: it is a fixture). */
  accessToken: 'tok-1',
  requests: [] as { method: string; url: string; authorization?: string }[],
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
  }),
  createGatewayProfile: jest.fn((input: { name: string; url: string; kind?: string; token?: string }) => ({
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
  probeHighPriorityCandidates: jest.fn(async (urls: string[]) =>
    urls.includes(GATE_URL)
      ? { ok: true, url: GATE_URL, latencyMs: 0, hasManifest: true }
      : null,
  ),
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
  clearRunProgressThrottles: jest.fn(),
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
  signDevicePayload: jest.fn(async () => 'signed-payload'),
}));

jest.mock('@/lib/bot-avatar', () => ({ registerCrestFleet: jest.fn() }));

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { OnboardingScreen } from '@/components/onboarding/onboarding-screen';
import { GatewayProvider, useGateway, type GatewayContextValue } from '@/context/gateway-provider';
import { resetHostLookupMemoryForTests } from '@/lib/gateway/host-lookup';
import { keyValueStorage } from '@/lib/storage/key-value';
import { probeHighPriorityCandidates } from '@/lib/gateway/probe';
import type { GatewayProfile } from '@/lib/gateway/types';
import type { GatewayManifest } from '@/lib/portal/manifest';

const GATE_URL = 'http://my-pc.tail1234.ts.net:8760';
/** The same address the way the operator types it: no scheme. */
const GATE_HOST = 'my-pc.tail1234.ts.net:8760';
const REQUEST_ID = 'req-1';
const APPROVE_TEXT = 'Approve this phone on your PC';

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
 * The Gate's answers for this file: the manifest identifies it, the signed
 * access endpoint queues or grants this phone, and every /v1/* route needs the
 * bearer token the queue has not issued yet.
 */
const gateFetch = jest.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const authorization = headerValue(init, 'authorization');
  mockState.requests.push({ method: init?.method ?? 'GET', url, authorization });
  const body = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  if (url.includes('/.well-known/gateway/access/status')) {
    return body({ status: mockState.access === 'pending' ? 'pending' : 'not-pending', requestId: REQUEST_ID });
  }
  if (url.includes('/.well-known/gateway/access')) {
    return mockState.access === 'pending'
      ? body({ status: 'pending', requestId: REQUEST_ID }, 202)
      : body({ status: 'granted', token: mockState.accessToken });
  }
  if (url.includes('/.well-known/gateway.json')) return body(GATE_MANIFEST);
  if (url.endsWith('/health')) return body({ status: 'ok', platform: 'win32', version: '0.18.0' });
  if (!authorization) {
    return new Response(JSON.stringify({ error: 'Unauthorized', message: 'Bearer token required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return body({ data: [] });
});

const observed: { gateway: GatewayContextValue | null } = { gateway: null };

function Capture() {
  observed.gateway = useGateway();
  return null;
}

function gatewayApi(): GatewayContextValue {
  if (!observed.gateway) throw new Error('the provider has not mounted');
  return observed.gateway;
}

let renderer: TestRenderer.ReactTestRenderer | null = null;

async function settle(rounds = 10, ms = 0): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }
}

/** Mounts the provider with the real onboarding screen, as first run does. */
async function mount(): Promise<void> {
  await act(async () => {
    renderer = TestRenderer.create(
      <GatewayProvider>
        <OnboardingScreen />
        <Capture />
      </GatewayProvider>,
    );
  });
  await settle(6, 0);
}

async function unmount(): Promise<void> {
  if (!renderer) return;
  const doomed = renderer;
  renderer = null;
  await act(async () => {
    doomed.unmount();
  });
}

/** The typed address + no key path: this is how a phone asks to pair. */
async function setupFromPcAddress(pcAddress: string): Promise<void> {
  await act(async () => {
    const pending = gatewayApi().setupFromPcAddress(pcAddress);
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    await pending;
  });
  await settle(8, 1_000);
}

function stringsIn(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(stringsIn);
  if (node && typeof node === 'object' && 'children' in node) {
    return stringsIn((node as { children: unknown }).children);
  }
  return [];
}

function renderedText(): string {
  return renderer ? stringsIn(renderer.toJSON()).join(' ') : '';
}

/** Requests the connect fan-out would have made; a pending pairing makes none. */
function authenticatedRequests(): string[] {
  return mockState.requests.filter((request) => request.url.includes('/v1/')).map((request) => request.url);
}

async function clearPendingPairingMarker(): Promise<void> {
  const keys = await keyValueStorage.getAllKeys();
  await keyValueStorage.multiRemove(keys.filter((key) => key.includes('pending-pairing')));
}

beforeEach(async () => {
  await clearPendingPairingMarker();
  jest.useFakeTimers();
  resetHostLookupMemoryForTests();
  (globalThis as { fetch: unknown }).fetch = gateFetch as unknown as typeof fetch;
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.settings = { autoConnect: false, onboardingComplete: false, voiceEngine: 'auto' };
  mockState.access = 'pending';
  mockState.accessToken = 'tok-1';
  mockState.requests = [];
  observed.gateway = null;
  mockRouter.replace.mockClear();
  jest.mocked(probeHighPriorityCandidates).mockClear();
});

afterEach(async () => {
  await unmount();
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  await clearPendingPairingMarker();
});

describe('a phone the Gate has only queued for approval', () => {
  test('asking to pair does not mark onboarding complete', async () => {
    await mount();
    await setupFromPcAddress(GATE_HOST);

    // The Gate answered 202: this phone is waiting, and no device token exists.
    expect(gatewayApi().connectionPhase).toBe('pairing');
    expect(gatewayApi().pairingDetails?.remediationHint).toContain(APPROVE_TEXT);
    expect(gatewayApi().pairingDetails?.requestId).toBe(REQUEST_ID);
    expect(gatewayApi().needsOnboarding).toBe(true);
    expect(mockState.settings.onboardingComplete).toBe(false);
    expect(mockState.settings.manualSetupPending).toBe(true);
    // The profile that waits for the approval is saved, still token-less.
    const saved = mockState.gateways.find((item) => item.url === GATE_URL);
    expect(saved).toBeDefined();
    expect(saved?.token).toBeUndefined();
  });

  test('a relaunch mid-pairing restores the approve state and still is not complete', async () => {
    await mount();
    await setupFromPcAddress(GATE_HOST);
    expect(gatewayApi().connectionPhase).toBe('pairing');

    // The relaunch: everything a process restart keeps — saved profiles and
    // settings — and nothing the old process held in memory.
    await unmount();
    observed.gateway = null;
    const probesBefore = jest.mocked(probeHighPriorityCandidates).mock.calls.length;
    mockState.requests = [];

    await mount();

    // The approve instructions are back on screen...
    expect(gatewayApi().connectionPhase).toBe('pairing');
    expect(renderedText()).toMatch(/Approve this phone on your PC|On your PC, open http:\/\/localhost:8760\/pair/);
    expect(gatewayApi().pairingDetails?.remediationHint).toContain(APPROVE_TEXT);
    expect(gatewayApi().pairingDetails?.requestId).toBe(REQUEST_ID);
    // ...onboarding is still open, and never claimed to be complete...
    expect(gatewayApi().needsOnboarding).toBe(true);
    expect(mockState.settings.onboardingComplete).toBe(false);
    // ...and no anonymous connect was attempted, so Chat cannot say
    // "pair it again" over a request that is already queued.
    expect(jest.mocked(probeHighPriorityCandidates).mock.calls.length).toBe(probesBefore);
    expect(gatewayApi().status).not.toBe('connected');
    expect(authenticatedRequests()).toHaveLength(0);
  });
});
