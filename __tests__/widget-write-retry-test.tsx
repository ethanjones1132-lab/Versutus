// The widget's write path, mounted.
//
// The write gate is pure and correct on its own (`widget-write-gate-test.ts`):
// what was broken was everything between it and the card. A refused write was
// charged as accepted, so the card froze on "Open Versutus to connect" while the
// gate believed the write had gone out; nothing ever fed the gate a later `now`,
// so the five-minute floor that refreshes a frozen card could not fire; and a
// removed gateway's Bot names stayed on the home screen forever because the one
// native function built to clear the card had no caller.
//
// The provider is driven here through the same harness `gateway-provider-
// connected-reads-test.tsx` uses: a fake client, fake timers, and the seam
// mocked so the write's own outcome is this file's to answer.

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { AppState, type AppStateStatus } from 'react-native';

import {
  GatewayProvider,
  useGateway,
  type GatewayContextValue,
} from '@/context/gateway-provider';
import { gateManifestCacheKey } from '@/lib/portal/attach-manifest';
import { keyValueStorage } from '@/lib/storage/key-value';
import type { ConnectionStatus, GatewayProfile, HermesSession } from '@/lib/gateway/types';
import type { PortalClient, PortalClientCallbacks } from '@/lib/portal/adapters';
import type { GatewayManifest } from '@/lib/portal/manifest';
import { androidWidgetPayload } from '@/lib/widget/android-widget-payload';
import * as widgetDevice from '@/lib/widget/widget-device';
import type { VersutusWidgetPayload } from '../modules/versutus-widget/src/VersutusWidget.types';
import {
  WIDGET_WRITE_FLOOR_MS,
  WIDGET_WRITE_RETRY_MAX_MS,
  WIDGET_WRITE_RETRY_MS,
} from '@/lib/widget/widget-write-gate';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

jest.mock('@/lib/widget/widget-device', () => ({
  writeWidgetSnapshot: jest.fn(),
  clearWidgetSnapshot: jest.fn(),
}));

const mockState = {
  gateways: [] as GatewayProfile[],
  activeId: null as string | null,
  settings: { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' },
  manifests: new Map<string, GatewayManifest | null>(),
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
  probeGatewayUrl: jest.fn(async () => ({ ok: true, url: 'http://alpha.test:8642' })),
  probeHighPriorityCandidates: jest.fn(async () => null),
}));

jest.mock('@/lib/portal/manifest', () => {
  const actual = jest.requireActual('@/lib/portal/manifest') as Record<string, unknown>;
  return {
    ...actual,
    fetchGatewayManifestWithLookupRetry: jest.fn(async (url: string) => {
      return mockState.manifests.get(url) ?? null;
    }),
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

jest.mock('@/lib/portal/adapters', () => ({
  createClientForKind: jest.fn((_kind: string, gateway: GatewayProfile, callbacks: PortalClientCallbacks) => {
    const client = mockMakeClient(callbacks, gateway.id);
    mockClients.push(client);
    return client;
  }),
}));

const GATE_MANIFEST = {
  manifest: 'versutus-gateway/v1',
  kind: 'versutus-gate',
  name: 'Versutus Gate',
  endpoints: {
    health: '/health',
    models: '/v1/models',
    chat: '/v1/chat/completions',
    capabilitiesRpc: '/v1/capabilities/rpc',
  },
  auth: { schemes: ['bearer'] },
} as unknown as GatewayManifest;

const HELLO = { type: 'hello-ok', protocol: 1, server: { version: '0.18.0' } };
const SESSION = { id: 'live-session', title: 'Live', createdAt: 0 } as unknown as HermesSession;
const HEALTHY = { status: 'ok' };
const CRON_JOB = {
  id: 'job-sweep',
  title: 'Minute sweep',
  name: '[bot:scout] Minute sweep',
  schedule: '0 9 * * *',
  nextRunAt: '2999-01-01T09:00:00.000Z',
};

/** Each gateway's own roster, so a switch can be told apart on the card. */
const ROSTERS: Record<string, { id: string; displayName: string }[]> = {
  alpha: [{ id: 'scout', displayName: 'Scout' }],
  beta: [{ id: 'keel', displayName: 'Keel' }],
};

const mockClients: FakeClient[] = [];

type FakeClient = PortalClient & { gatewayId: string };

function mockMakeClient(callbacks: PortalClientCallbacks, gatewayId: string): FakeClient {
  let sessionId: string | undefined;
  const client = {
    gatewayId,
    connectionStatus: 'disconnected' as ConnectionStatus,
    statusDetail: '',
    authRejected: false,
    botId: undefined,
    canManageSessions: true,
    rpcMethods: [] as string[],
    listCronJobs: async () => [CRON_JOB],
    connect: async () => {
      await connectScript(
        callbacks,
        (next) => {
          client.connectionStatus = next;
        },
        gatewayId,
      );
    },
    disconnect: () => {
      client.connectionStatus = 'disconnected';
    },
    updateProfile: () => undefined,
    get sessionId() {
      return sessionId;
    },
    set sessionId(id: string | undefined) {
      sessionId = id;
    },
    healthCheck: async () => HEALTHY,
    rpcRequest: async (method: string) => {
      client.rpcMethods.push(method);
      return { data: [] };
    },
    streamChat: async () => 'pong',
    getModels: async () => [{ id: 'm1', object: 'model' }],
    getCapabilities: async () => ({ chat: true, models: true }),
    getSessions: async () => [SESSION],
    createSession: async () => SESSION,
    getSessionMessages: async () => [],
    stopRun: async () => undefined,
    setBotId: () => undefined,
    setBackendId: () => undefined,
    suspendReconnect: () => undefined,
    resumeReconnect: () => undefined,
    forceReconnect: () => {
      client.connectionStatus = 'reconnecting';
      callbacks.onStatus?.('reconnecting', 'Checking the connection');
    },
    listBots: async () => ROSTERS[gatewayId] ?? [],
    listJobs: async () => [{ id: CRON_JOB.id, name: CRON_JOB.name, schedule: CRON_JOB.schedule }],
  };
  return client as unknown as FakeClient;
}

type ConnectScript = (
  callbacks: PortalClientCallbacks,
  setStatus: (next: ConnectionStatus) => void,
  gatewayId: string,
) => Promise<void>;

const CONNECT_OK: ConnectScript = async (callbacks, setStatus) => {
  setStatus('connecting');
  callbacks.onStatus?.('connecting', 'Connecting…');
  setStatus('connected');
  callbacks.onStatus?.('connected');
  callbacks.onHello?.(HELLO);
  callbacks.onHealthCheck?.(true, HEALTHY as never);
};

let connectScript: ConnectScript = CONNECT_OK;

const observed: { gateway: GatewayContextValue | null } = { gateway: null };

function recordGateway(gateway: GatewayContextValue): null {
  observed.gateway = gateway;
  return null;
}

function Capture() {
  return recordGateway(useGateway());
}

function gatewayApi(): GatewayContextValue {
  if (!observed.gateway) throw new Error('the provider has not mounted');
  return observed.gateway;
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

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
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

async function mount(): Promise<void> {
  await act(async () => {
    renderer = TestRenderer.create(
      <GatewayProvider>
        <Capture />
      </GatewayProvider>,
    );
  });
  await settle(6, 0);
}

/** Every payload the seam was handed, oldest first. */
function writes(): VersutusWidgetPayload[] {
  return jest.mocked(widgetDevice.writeWidgetSnapshot).mock.calls.map(
    ([snapshot]) => androidWidgetPayload(snapshot),
  );
}

function bootAlpha(): Promise<void> {
  const alpha = profile({ id: 'alpha', url: 'http://alpha.test:8642', kind: 'custom' });
  mockState.gateways = [alpha];
  mockState.activeId = alpha.id;
  mockState.manifests.set(alpha.url, GATE_MANIFEST);
  return mount();
}

beforeEach(async () => {
  await keyValueStorage.removeItem(gateManifestCacheKey('alpha'));
  await keyValueStorage.removeItem(gateManifestCacheKey('beta'));
  jest.useFakeTimers();
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.settings = { autoConnect: true, onboardingComplete: true, voiceEngine: 'auto' };
  mockState.manifests = new Map();
  mockClients.length = 0;
  connectScript = CONNECT_OK;
  observed.gateway = null;
  appStateListeners = [];
  jest.mocked(widgetDevice.writeWidgetSnapshot).mockReset().mockResolvedValue(true);
  jest.mocked(widgetDevice.clearWidgetSnapshot).mockReset().mockResolvedValue(undefined);
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

describe('a refused write is retried rather than charged against the floor', () => {
  test('the same snapshot is re-offered on a ladder when no fact ever moves again', async () => {
    jest.mocked(widgetDevice.writeWidgetSnapshot).mockResolvedValue(false);
    await bootAlpha();
    await settle(6, 2_000);

    // The roster landed and the snapshot went out — and was refused. Every write
    // so far was, so the gate holds nothing and owes this card another attempt.
    const refused = writes().length;
    expect(refused).toBeGreaterThan(0);
    expect(writes().at(-1)?.bots).toEqual([{ id: 'scout', label: 'scout' }]);

    // Nothing about the facts will ever move again, so the same snapshot is
    // re-offered on a ladder: 30 s, each gap doubling, and the cap holding the
    // last gap flat rather than letting it grow without end.
    for (const gap of [
      WIDGET_WRITE_RETRY_MS,
      WIDGET_WRITE_RETRY_MS * 2,
      WIDGET_WRITE_RETRY_MAX_MS / 2,
      WIDGET_WRITE_RETRY_MAX_MS,
      WIDGET_WRITE_RETRY_MAX_MS,
    ]) {
      const before = writes().length;
      await advance(gap);
      expect(writes()).toHaveLength(before + 1);
    }

    // Every one of them the same card: nothing about the facts changed.
    expect(new Set(writes().map((payload) => payload.work))).toEqual(new Set(['No runs in flight']));
  });

  test('the first accepted write resets the ladder', async () => {
    const seam = jest.mocked(widgetDevice.writeWidgetSnapshot);
    seam.mockResolvedValue(false);
    await bootAlpha();
    await settle(6, 2_000);
    const refused = seam.mock.calls.length;
    expect(refused).toBeGreaterThan(0);

    await advance(WIDGET_WRITE_RETRY_MS);
    expect(seam).toHaveBeenCalledTimes(refused + 1);

    // Everything from here on is accepted: no ladder is running, and no floor
    // has matured, so nothing else is owed for five minutes.
    seam.mockResolvedValue(true);
    await advance(WIDGET_WRITE_RETRY_MAX_MS);
    expect(seam).toHaveBeenCalledTimes(refused + 2);
  });
});

describe('the five-minute floor really fires', () => {
  test('an unchanged card is rewritten at the floor, and not one tick before it', async () => {
    await bootAlpha();
    await settle(6, 2_000);
    const settled = writes().length;
    expect(settled).toBeGreaterThan(0);
    const firstStamp = writes().at(-1)?.writtenAt ?? 0;

    await advance(WIDGET_WRITE_FLOOR_MS - 60_000);
    expect(writes()).toHaveLength(settled);

    await advance(60_000);
    expect(writes()).toHaveLength(settled + 1);
    // The stamp says when the rewrite went out, so the card never reads frozen.
    expect(writes().at(-1)?.writtenAt).toBeGreaterThan(firstStamp);
    expect(writes().at(-1)?.work).toBe('No runs in flight');
  });

  test('a foreground return past the floor writes, even with every timer asleep', async () => {
    await bootAlpha();
    await settle(6, 2_000);
    const settled = writes().length;
    expect(settled).toBeGreaterThan(0);
    const firstStamp = writes().at(-1)?.writtenAt ?? 0;

    // JS timers freeze while the app is backgrounded, so the floor's own timer
    // cannot be the only edge. The clock moves without any timer coming due.
    jest.setSystemTime(Date.now() + WIDGET_WRITE_FLOOR_MS + 60_000);
    expect(writes()).toHaveLength(settled);

    await act(async () => {
      for (const listener of appStateListeners) listener('active');
    });
    expect(writes()).toHaveLength(settled + 1);
    expect(writes().at(-1)?.writtenAt).toBeGreaterThan(firstStamp);
  });

  test('the timers are dropped on unmount rather than left to fire into nothing', async () => {
    await bootAlpha();
    await settle(6, 2_000);
    const settled = writes().length;

    // The card owes the floor, so a timer is genuinely pending: this is the state
    // the pre-fix provider sat in with nothing pending and nothing arriving.
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    await act(async () => {
      renderer?.unmount();
      renderer = null;
    });
    await advance(WIDGET_WRITE_FLOOR_MS * 2);

    expect(writes()).toHaveLength(settled);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('a removed gateway leaves the card', () => {
  test('deleting the only gateway clears the card once', async () => {
    await bootAlpha();
    await settle(6, 2_000);
    const beforeWrites = writes().length;
    // The roster the card is carrying belongs to the gateway about to be deleted.
    expect(writes().at(-1)?.bots).toEqual([{ id: 'scout', label: 'scout' }]);
    expect(widgetDevice.clearWidgetSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      await gatewayApi().deleteGateway('alpha');
    });
    await settle(4, 1_000);

    expect(widgetDevice.clearWidgetSnapshot).toHaveBeenCalledTimes(1);
    // The card's storage is app-private and outlives the session: no later write
    // would ever cover the deleted gateway's names.
    for (const payload of writes().slice(beforeWrites)) {
      expect(payload.bots ?? []).toEqual([]);
    }
  });

  test('an absent gateway from the start is cleared once, not once per re-render', async () => {
    await mount();
    await settle(4, 2_000);

    expect(widgetDevice.clearWidgetSnapshot).toHaveBeenCalledTimes(1);
    expect(widgetDevice.writeWidgetSnapshot).not.toHaveBeenCalled();
  });
});

describe('switching gateways never writes the previous roster', () => {
  test('no payload after the switch names the old gateway Bot', async () => {
    const beta = profile({ id: 'beta', url: 'http://beta.test:8642', kind: 'custom' });
    await bootAlpha();
    mockState.gateways.push(beta);
    mockState.manifests.set(beta.url, GATE_MANIFEST);
    await settle(6, 2_000);

    expect(writes().at(-1)?.bots).toEqual([{ id: 'scout', label: 'scout' }]);
    const atSwitch = writes().length;

    // Park beta's connect at "connecting". A switch is two renders deep — the
    // active id moves first and beta's roster lands a read later — and parking
    // holds that window open instead of letting a fast connect close it before
    // anything is written. The status word moving is what forces the write.
    let releaseBeta: () => void = () => undefined;
    const betaReady = new Promise<void>((resolve) => {
      releaseBeta = resolve;
    });
    connectScript = async (callbacks, setStatus, gatewayId) => {
      if (gatewayId !== 'beta') {
        await CONNECT_OK(callbacks, setStatus, gatewayId);
        return;
      }
      setStatus('connecting');
      callbacks.onStatus?.('connecting', 'Connecting…');
      await betaReady;
      setStatus('connected');
      callbacks.onStatus?.('connected');
      callbacks.onHello?.(HELLO);
      callbacks.onHealthCheck?.(true, HEALTHY as never);
    };
    const switching = gatewayApi().connectGateway(beta);
    await settle(6, 2_000);

    // The card is mid-switch here: beta is the active gateway, its roster has
    // not landed, and alpha's is the only list the provider still holds.
    const duringSwitch = writes().slice(atSwitch);
    expect(duringSwitch.length).toBeGreaterThan(0);
    for (const payload of duringSwitch) {
      expect((payload.bots ?? []).map((bot) => bot.id)).not.toContain('scout');
    }

    releaseBeta();
    await act(async () => {
      await switching;
    });
    await settle(8, 2_000);

    for (const payload of writes().slice(atSwitch)) {
      expect((payload.bots ?? []).map((bot) => bot.id)).not.toContain('scout');
    }
    expect(writes().at(-1)?.bots).toEqual([{ id: 'keel', label: 'keel' }]);
  });
});
