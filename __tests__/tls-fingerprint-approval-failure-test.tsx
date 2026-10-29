import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { GatewayProfile as MockGatewayProfile } from '@/lib/gateway/types';

// The TLS change prompt is the only way back to a connected gateway once a
// beacon disagrees with the saved fingerprint. This suite drives the real
// provider, guard and sheet with storage/connection injected, because the bug
// was not the copy on the sheet — it was the ordering: the prompt was cleared
// before the save settled, so a refusal dismissed the recovery UI, fired a
// success haptic, and left an unhandled rejection.
//
// Every failure below must keep the prompt on screen with a plain reason, must
// not call the connection at all until the fingerprint is stored, and must not
// let a completion from an older decision touch a newer one.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));

type UpsertMode = 'immediate' | 'defer' | 'reject';
type ConnectMode = 'connected' | 'silent' | 'reject';

type PendingUpsert = {
  resolve: () => void;
  reject: (error: unknown) => void;
};

const mockState = {
  gateways: [] as import('@/lib/gateway/types').GatewayProfile[],
  activeId: null as string | null,
  settings: { autoConnect: false, onboardingComplete: true, voiceEngine: 'auto' },
  created: 0,
  /** How the real upsert behaves: land now, wait for the test, or refuse. */
  upsertMode: 'immediate' as UpsertMode,
  upsertCalls: [] as import('@/lib/gateway/types').GatewayProfile[],
  pendingUpsert: null as PendingUpsert | null,
  /** How the fake client's connect() behaves once the attach runs. */
  connectMode: 'connected' as ConnectMode,
  connectCalls: [] as import('@/lib/gateway/types').GatewayProfile[],
  attachedProfiles: [] as import('@/lib/gateway/types').GatewayProfile[],
  clients: [] as unknown[],
  rejections: [] as unknown[],
};

jest.mock('@/lib/gateway/storage', () => ({
  loadGateways: jest.fn(async () =>
    mockState.gateways.map((gateway: import('@/lib/gateway/types').GatewayProfile) => ({ ...gateway })),
  ),
  saveGateways: jest.fn(async () => undefined),
  removeGatewayIds: jest.fn(async (ids: readonly string[]) => {
    mockState.gateways = mockState.gateways.filter(
      (gateway: import('@/lib/gateway/types').GatewayProfile) => !ids.includes(gateway.id),
    );
    return mockState.gateways.map((gateway: import('@/lib/gateway/types').GatewayProfile) => ({ ...gateway }));
  }),
  upsertGateway: jest.fn((gateway: import('@/lib/gateway/types').GatewayProfile) => {
    mockState.upsertCalls.push({ ...gateway });
    const apply = () => {
      mockState.gateways = mockState.gateways.some(
        (item: import('@/lib/gateway/types').GatewayProfile) => item.id === gateway.id,
      )
        ? mockState.gateways.map((item: import('@/lib/gateway/types').GatewayProfile) =>
            item.id === gateway.id ? { ...gateway } : item,
          )
        : [...mockState.gateways, { ...gateway }];
      return mockState.gateways.map(
        (item: import('@/lib/gateway/types').GatewayProfile) => ({ ...item }),
      );
    };
    if (mockState.upsertMode === 'reject') {
      const refusal = new Error('secure storage refused the write');
      mockState.rejections.push(refusal);
      return Promise.reject(refusal);
    }
    if (mockState.upsertMode === 'defer') {
      return new Promise<MockGatewayProfile[]>((resolve, reject) => {
        mockState.pendingUpsert = {
          resolve: () => resolve(apply()),
          reject: (error) => reject(error),
        };
      });
    }
    return Promise.resolve(apply());
  }),
  removeGateway: jest.fn(async (id: string) => {
    mockState.gateways = mockState.gateways.filter(
      (gateway: import('@/lib/gateway/types').GatewayProfile) => gateway.id !== id,
    );
    return mockState.gateways.map(
      (gateway: import('@/lib/gateway/types').GatewayProfile) => ({ ...gateway }),
    );
  }),
  addGatewayProfile: jest.fn(async (profile: import('@/lib/gateway/types').GatewayProfile) => {
    const { mergeIntoExistingGateway } = jest.requireActual(
      '@/lib/gateway/profile-dedupe',
    ) as typeof import('@/lib/gateway/profile-dedupe');
    const merged = mergeIntoExistingGateway(mockState.gateways, profile);
    mockState.gateways = merged.gateways.map(
      (gateway: import('@/lib/gateway/types').GatewayProfile) => ({ ...gateway }),
    );
    return {
      profile: { ...merged.profile },
      gateways: mockState.gateways.map(
        (gateway: import('@/lib/gateway/types').GatewayProfile) => ({ ...gateway }),
      ),
    };
  }),
  repairDuplicateGateways: jest.fn(async () => ({
    gateways: mockState.gateways.map(
      (gateway: import('@/lib/gateway/types').GatewayProfile) => ({ ...gateway }),
    ),
    activeId: mockState.activeId,
  })),
  loadActiveGatewayId: jest.fn(async () => mockState.activeId),
  saveActiveGatewayId: jest.fn(async (id: string | null) => {
    mockState.activeId = id;
  }),
  createGatewayProfile: jest.fn(
    (input: {
      name: string;
      url: string;
      kind?: import('@/lib/gateway/types').GatewayProfile['kind'];
      token?: string;
      bootstrapToken?: string;
      tlsFingerprint?: string;
      sessionKey?: string;
      sessionId?: string;
      agentId?: string;
      discoverySource?: import('@/lib/gateway/types').GatewayProfile['discoverySource'];
    }) => {
      mockState.created += 1;
      return {
        id: `created-${mockState.created}`,
        name: input.name,
        url: input.url,
        kind: input.kind,
        token: input.token,
        tlsFingerprint: input.tlsFingerprint,
        createdAt: 0,
        sessionKey: input.sessionKey,
        sessionId: input.sessionId,
        agentId: input.agentId,
        discoverySource: input.discoverySource,
      };
    },
  ),
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
    fetchGatewayManifestWithLookupRetry: jest.fn(async () => null),
  };
});

jest.mock('@/lib/portal/attach-manifest', () => ({
  cachedManifestIpv4ByProfileId: jest.fn(async () => ({})),
  lateManifestUpgradesClient: jest.fn(() => false),
  loadCachedGateManifest: jest.fn(async () => null),
  manifestForAttach: jest.fn(async () => ({ manifest: null, source: 'none' })),
  saveCachedGateManifest: jest.fn(async () => undefined),
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

jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({
    scheme: 'dark',
    backgroundInset: '#101014',
    borderSubtle: '#26262e',
  }),
}));

// The sheet stays real; only its chrome is a host node, so a press reaches the
// actual approve handler and the haptic it fires.
jest.mock('@/components/ui', () => ({
  BaseSheet: 'BaseSheet',
  Button: 'Button',
  Divider: 'Divider',
  Text: 'Text',
}));

// The connection is injected, not assumed: the fake client can land connected,
// fulfil without announcing `connected`, or reject outright.
type FakeClient = {
  connectionStatus: import('@/lib/gateway/types').ConnectionStatus;
  statusDetail: string;
  authRejected: boolean;
  canManageSessions: boolean;
  botId: string | undefined;
  sessionId: string | undefined;
  connect: () => Promise<void>;
  disconnect: () => void;
  updateProfile: () => void;
  setSessionId: (id: string | undefined) => void;
  healthCheck: () => Promise<{ status: string }>;
  rpcRequest: () => Promise<Record<string, unknown>>;
  streamChat: () => Promise<string>;
  getModels: () => Promise<{ id: string; object: string }[]>;
  getCapabilities: () => Promise<Record<string, unknown>>;
  getSessions: () => Promise<never[]>;
  createSession: () => Promise<{ id: string }>;
  getSessionMessages: () => Promise<never[]>;
  stopRun: () => Promise<void>;
  setBotId: () => void;
  setBackendId: () => void;
  suspendReconnect: () => void;
  resumeReconnect: () => void;
};

function mockMakeClient(
  callbacks: import('@/lib/portal/adapters').PortalClientCallbacks,
  gateway: import('@/lib/gateway/types').GatewayProfile,
): FakeClient {
  let connectionStatus: import('@/lib/gateway/types').ConnectionStatus = 'disconnected';
  let sessionId: string | undefined;
  const client: FakeClient = {
    canManageSessions: true,
    get connectionStatus() {
      return connectionStatus;
    },
    statusDetail: '',
    authRejected: false,
    botId: undefined,
    get sessionId() {
      return sessionId;
    },
    set sessionId(id: string | undefined) {
      sessionId = id;
    },
    connect: async () => {
      mockState.connectCalls.push({ ...gateway });
      connectionStatus = 'connecting';
      callbacks.onStatus?.('connecting', 'Connecting…');
      if (mockState.connectMode === 'reject') {
        connectionStatus = 'disconnected';
        throw new Error('handshake refused');
      }
      if (mockState.connectMode === 'silent') {
        // Fulfilled, but the gateway never reported `connected`: the provider
        // must not treat the resolved attach as proof of connectivity.
        return;
      }
      connectionStatus = 'connected';
      callbacks.onStatus?.('connected');
    },
    disconnect: () => {
      connectionStatus = 'disconnected';
    },
    updateProfile: () => undefined,
    setSessionId: (id: string | undefined) => {
      sessionId = id;
    },
    healthCheck: async () => ({ status: 'ok' }),
    rpcRequest: async () => ({}),
    streamChat: async () => '',
    getModels: async () => [{ id: 'm-old', object: 'model' }],
    getCapabilities: async () => ({}),
    getSessions: async () => [],
    createSession: async () => ({ id: 'session-1' }),
    getSessionMessages: async () => [],
    stopRun: async () => undefined,
    setBotId: () => undefined,
    setBackendId: () => undefined,
    suspendReconnect: () => undefined,
    resumeReconnect: () => undefined,
  };
  return client;
}

jest.mock('@/lib/portal/adapters', () => ({
  createClientForKind: jest.fn(
    (
      _kind: string,
      gateway: import('@/lib/gateway/types').GatewayProfile,
      callbacks: import('@/lib/portal/adapters').PortalClientCallbacks,
    ) => {
      mockState.attachedProfiles.push({ ...gateway });
      const client = mockMakeClient(callbacks, gateway);
      mockState.clients.push(client);
      return client;
    },
  ),
}));

import { haptics } from '@/lib/haptics';
import { TlsFingerprintGuard } from '@/components/gateway/tls-fingerprint-guard';
import { TlsFingerprintChangeSheet } from '@/components/gateway/tls-fingerprint-change-sheet';
import {
  GatewayProvider,
  useGateway,
  type GatewayContextValue,
} from '@/context/gateway-provider';
import type { GatewayProfile } from '@/lib/gateway/types';

const observed: { gateway: GatewayContextValue | null } = { gateway: null };

function Capture() {
  const gateway = useGateway();
  React.useEffect(() => { observed.gateway = gateway; }, [gateway]);
  return null;
}

function gatewayApi(): GatewayContextValue {
  if (!observed.gateway) throw new Error('the provider has not mounted');
  return observed.gateway;
}

let renderer: TestRenderer.ReactTestRenderer | null = null;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

async function settle(rounds = 12, ms = 0): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    // Real timers on purpose: an unhandled rejection is reported by the
    // process, not by React, and a faked event loop would never turn over.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = TestRenderer.create(
      <GatewayProvider>
        <TlsFingerprintGuard />
        <Capture />
      </GatewayProvider>,
    );
  });
  await settle();
}

function savedGateway(overrides: Partial<GatewayProfile> = {}): GatewayProfile {
  return {
    id: 'alpha',
    name: 'alpha',
    url: 'http://alpha.test:8642',
    kind: 'hermes',
    token: 'token-1',
    model: 'm-old',
    tlsFingerprint: 'AA',
    createdAt: 0,
    ...overrides,
  };
}

/** Raises the real prompt through the beacon path the app uses. */
async function raisePrompt(url: string, observedFingerprint: string): Promise<void> {
  await act(async () => {
    await gatewayApi().addGateway({ name: 'beacon', url, tlsFingerprint: observedFingerprint });
  });
  await settle();
  if (!gatewayApi().tlsFingerprintChange) throw new Error('the TLS prompt did not open');
}

function button(label: string): TestRenderer.ReactTestInstance {
  const found = renderer?.root.findAll(
    (node) => node.type === ('Button' as unknown as React.ElementType) && node.props.label === label,
  );
  if (!found || found.length === 0) throw new Error(`Button "${label}" is not on screen`);
  return found[0];
}

function screenText(): string {
  return (
    renderer?.root
      .findAll(() => true)
      .flatMap((node) => {
        const children = node.props?.children;
        if (typeof children === 'string' || typeof children === 'number') return [String(children)];
        if (Array.isArray(children)) {
          return children.filter(
            (child) => typeof child === 'string' || typeof child === 'number',
          ).map(String);
        }
        return [];
      })
      .join('\n') ?? ''
  );
}

function successHaptics(): jest.Mock {
  return haptics.success as jest.Mock;
}

beforeEach(() => {
  mockState.gateways = [];
  mockState.activeId = null;
  mockState.settings = { autoConnect: false, onboardingComplete: true, voiceEngine: 'auto' };
  mockState.created = 0;
  mockState.upsertMode = 'immediate';
  mockState.upsertCalls.length = 0;
  mockState.pendingUpsert = null;
  mockState.connectMode = 'connected';
  mockState.connectCalls.length = 0;
  mockState.attachedProfiles.length = 0;
  mockState.clients.length = 0;
  mockState.rejections.length = 0;
  observed.gateway = null;
  unhandled.length = 0;
  jest.clearAllMocks();
  process.on('unhandledRejection', onUnhandled);
});

afterEach(async () => {
  if (renderer) {
    await act(async () => {
      renderer?.unmount();
    });
    renderer = null;
  }
  process.off('unhandledRejection', onUnhandled);
  jest.restoreAllMocks();
});

describe('TLS fingerprint approval is awaited, recoverable and owned', () => {
  test('a deferred save keeps the prompt open and withholds the success haptic until the write lands', async () => {
    mockState.gateways = [savedGateway()];
    mockState.activeId = 'alpha';
    await mount();
    await raisePrompt('http://alpha.test:8642', 'BB');

    mockState.upsertMode = 'defer';
    await act(async () => {
      void button('Trust new fingerprint').props.onPress();
    });
    await settle();

    // The prompt is still the only recovery UI, the write is in flight, and no
    // connection or success signal has happened yet.
    expect(mockState.upsertCalls).toHaveLength(1);
    expect(mockState.upsertCalls[0].tlsFingerprint).toBe('BB');
    expect(mockState.upsertCalls[0].tlsFingerprintTrusted).toBe(true);
    expect(gatewayApi().tlsFingerprintChange).toMatchObject({
      observedFingerprint: 'BB',
      pending: true,
    });
    expect(gatewayApi().tlsFingerprintChange?.error).toBeUndefined();
    expect(mockState.connectCalls).toHaveLength(0);
    expect(successHaptics()).not.toHaveBeenCalled();
    expect(button('Trust new fingerprint').props.disabled).toBe(true);
    expect(button('Stay disconnected').props.disabled).toBeFalsy();

    await act(async () => {
      mockState.pendingUpsert?.resolve();
    });
    await settle();

    expect(gatewayApi().tlsFingerprintChange).toBeNull();
    expect(successHaptics()).toHaveBeenCalledTimes(1);
    expect(mockState.connectCalls).toHaveLength(1);
    expect(mockState.connectCalls[0].tlsFingerprint).toBe('BB');
    expect(mockState.gateways.find((gateway) => gateway.id === 'alpha')?.tlsFingerprint).toBe('BB');
    expect(unhandled).toHaveLength(0);
  });

  test('a refused save keeps the prompt with a plain error, never reports success, and can retry', async () => {
    mockState.gateways = [savedGateway()];
    mockState.activeId = 'alpha';
    await mount();
    await raisePrompt('http://alpha.test:8642', 'BB');

    mockState.upsertMode = 'reject';
    await act(async () => {
      await button('Trust new fingerprint').props.onPress();
    });
    await settle();

    expect(gatewayApi().tlsFingerprintChange).toMatchObject({
      observedFingerprint: 'BB',
    });
    expect(gatewayApi().tlsFingerprintChange?.pending).toBeUndefined();
    expect(gatewayApi().tlsFingerprintChange?.error).toContain('Could not save the new fingerprint');
    expect(screenText()).toContain('Could not save the new fingerprint');
    expect(successHaptics()).not.toHaveBeenCalled();
    expect(mockState.upsertCalls).toHaveLength(1);
    expect(mockState.connectCalls).toHaveLength(0);
    // The failed write changed nothing on disk.
    expect(mockState.gateways[0].tlsFingerprint).toBe('AA');
    // Both answers are still usable: Stay disconnected is present, and the
    // approval button is ready for another attempt.
    expect(button('Stay disconnected').props.disabled).toBeFalsy();
    expect(button('Trust new fingerprint').props.disabled).toBe(false);
    expect(unhandled).toHaveLength(0);

    mockState.upsertMode = 'immediate';
    await act(async () => {
      await button('Trust new fingerprint').props.onPress();
    });
    await settle();

    expect(gatewayApi().tlsFingerprintChange).toBeNull();
    expect(successHaptics()).toHaveBeenCalledTimes(1);
    expect(mockState.upsertCalls).toHaveLength(2);
    expect(mockState.upsertCalls[1].tlsFingerprint).toBe('BB');
    expect(mockState.connectCalls).toHaveLength(1);
    expect(mockState.gateways[0].tlsFingerprint).toBe('BB');
  });

  test('a second approval while the write is in flight joins it instead of writing twice', async () => {
    mockState.gateways = [savedGateway()];
    mockState.activeId = 'alpha';
    await mount();
    await raisePrompt('http://alpha.test:8642', 'BB');

    mockState.upsertMode = 'defer';
    let first!: Promise<void>;
    await act(async () => {
      first = gatewayApi().approveTlsFingerprintChange();
      void gatewayApi().approveTlsFingerprintChange();
    });
    await settle();

    expect(mockState.upsertCalls).toHaveLength(1);
    expect(gatewayApi().tlsFingerprintChange?.pending).toBe(true);

    await act(async () => {
      mockState.pendingUpsert?.resolve();
      await first;
    });
    await settle();

    expect(mockState.upsertCalls).toHaveLength(1);
    expect(mockState.connectCalls).toHaveLength(1);
    expect(gatewayApi().tlsFingerprintChange).toBeNull();
    expect(successHaptics()).not.toHaveBeenCalled();
    expect(unhandled).toHaveLength(0);
  });

  test('two taps in the same tick are one write and one success haptic', async () => {
    mockState.gateways = [savedGateway()];
    mockState.activeId = 'alpha';
    await mount();
    await raisePrompt('http://alpha.test:8642', 'BB');

    mockState.upsertMode = 'defer';
    const approve = button('Trust new fingerprint');
    await act(async () => {
      void approve.props.onPress();
      void approve.props.onPress();
    });
    await settle();

    expect(mockState.upsertCalls).toHaveLength(1);
    expect(gatewayApi().tlsFingerprintChange?.pending).toBe(true);

    await act(async () => {
      mockState.pendingUpsert?.resolve();
    });
    await settle();

    expect(mockState.upsertCalls).toHaveLength(1);
    expect(mockState.connectCalls).toHaveLength(1);
    expect(gatewayApi().tlsFingerprintChange).toBeNull();
    expect(successHaptics()).toHaveBeenCalledTimes(1);
    expect(unhandled).toHaveLength(0);
  });

  test('rejecting during the write does not revive the prompt or connect afterwards', async () => {
    mockState.gateways = [savedGateway()];
    mockState.activeId = 'alpha';
    await mount();
    await raisePrompt('http://alpha.test:8642', 'BB');

    mockState.upsertMode = 'defer';
    let outcome!: Promise<string>;
    await act(async () => {
      outcome = gatewayApi()
        .approveTlsFingerprintChange()
        .then(
          () => 'resolved',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
    });
    await settle();
    expect(gatewayApi().tlsFingerprintChange?.pending).toBe(true);

    // Stay disconnected stays usable while the write is in flight.
    const stay = button('Stay disconnected');
    expect(stay.props.disabled).toBeFalsy();
    await act(async () => {
      stay.props.onPress();
    });
    await settle();
    expect(gatewayApi().tlsFingerprintChange).toBeNull();

    await act(async () => {
      mockState.pendingUpsert?.resolve();
    });
    await settle();

    expect(await outcome).toContain('replaced');
    // The dismissed prompt stays dismissed: no late error surface, no revived
    // sheet, and no attach against the answer the operator rejected.
    expect(gatewayApi().tlsFingerprintChange).toBeNull();
    expect(gatewayApi().lastError).toBeNull();
    expect(mockState.connectCalls).toHaveLength(0);
    expect(successHaptics()).not.toHaveBeenCalled();
    expect(unhandled).toHaveLength(0);
  });

  test('a completion from an older decision cannot clear or alter a newer prompt', async () => {
    mockState.gateways = [
      savedGateway(),
      savedGateway({ id: 'beta', name: 'beta', url: 'http://beta.test:8642', tlsFingerprint: 'CC' }),
    ];
    mockState.activeId = 'alpha';
    await mount();

    await raisePrompt('http://alpha.test:8642', 'A2');
    mockState.upsertMode = 'defer';
    let firstName!: Promise<string>;
    await act(async () => {
      firstName = gatewayApi()
        .approveTlsFingerprintChange()
        .then(
          () => 'resolved',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
    });
    await settle();
    expect(gatewayApi().tlsFingerprintChange?.observedFingerprint).toBe('A2');

    // A second beacon raises a different change while the first write pends.
    await raisePrompt('http://beta.test:8642', 'B2');
    expect(gatewayApi().tlsFingerprintChange).toMatchObject({
      previousFingerprint: 'CC',
      observedFingerprint: 'B2',
    });
    expect(gatewayApi().tlsFingerprintChange?.pending).toBeUndefined();
    expect(gatewayApi().tlsFingerprintChange?.error).toBeUndefined();

    await act(async () => {
      mockState.pendingUpsert?.resolve();
    });
    await settle();

    expect(await firstName).toContain('replaced');
    // The newer decision is untouched: the old save neither cleared it, gave
    // it the old error, nor connected with the old fingerprint.
    expect(gatewayApi().tlsFingerprintChange).toMatchObject({ observedFingerprint: 'B2' });
    expect(gatewayApi().tlsFingerprintChange?.error).toBeUndefined();
    expect(mockState.connectCalls).toHaveLength(0);
    expect(successHaptics()).not.toHaveBeenCalled();

    // The newer prompt then completes on its own key.
    mockState.upsertMode = 'immediate';
    await act(async () => {
      await gatewayApi().approveTlsFingerprintChange();
    });
    await settle();

    expect(gatewayApi().tlsFingerprintChange).toBeNull();
    expect(mockState.upsertCalls.map((call) => call.tlsFingerprint)).toEqual(['A2', 'B2']);
    expect(mockState.connectCalls.map((call) => call.tlsFingerprint)).toEqual(['B2']);
    expect(unhandled).toHaveLength(0);
  });

  test('a rejected decision cannot acquire a later approval of the same gateway and fingerprint', async () => {
    mockState.gateways = [savedGateway()];
    mockState.activeId = 'alpha';
    await mount();
    await raisePrompt('http://alpha.test:8642', 'BB');
    mockState.upsertMode = 'defer';
    let first!: Promise<string>;
    await act(async () => {
      first = gatewayApi().approveTlsFingerprintChange().then(
        () => 'resolved',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );
    });
    const oldWrite = mockState.pendingUpsert!;
    await act(async () => gatewayApi().rejectTlsFingerprintChange());
    await raisePrompt('http://alpha.test:8642', 'BB');
    let second!: Promise<string>;
    await act(async () => {
      second = gatewayApi().approveTlsFingerprintChange().then(
        () => 'resolved',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );
    });
    const newWrite = mockState.pendingUpsert!;
    await act(async () => oldWrite.resolve());
    await settle();
    expect(await first).toContain('replaced');
    expect(gatewayApi().tlsFingerprintChange).toMatchObject({ observedFingerprint: 'BB', pending: true });
    expect(mockState.connectCalls).toHaveLength(0);
    await act(async () => newWrite.resolve());
    await settle();
    expect(await second).toBe('resolved');
    expect(mockState.connectCalls).toHaveLength(1);
    expect(gatewayApi().tlsFingerprintChange).toBeNull();
  });

  test.each(['fingerprint', 'gateway'] as const)('a superseded sheet completion cannot clear a newer busy state or emit success (%s)', async (change) => {
    let finishOld!: () => void;
    let finishNew!: () => void;
    const oldApproval = new Promise<void>((resolve) => { finishOld = resolve; });
    const newApproval = new Promise<void>((resolve) => { finishNew = resolve; });
    const props = {
      visible: true,
      gatewayId: 'alpha',
      previousFingerprint: 'AA',
      observedFingerprint: 'BB',
      onReject: jest.fn(),
      onApprove: () => oldApproval,
    };
    await act(async () => { renderer = TestRenderer.create(<TlsFingerprintChangeSheet {...props} />); });
    await act(async () => { void button('Trust new fingerprint').props.onPress(); });
    await act(async () => {
      renderer!.update(<TlsFingerprintChangeSheet {...props}
        gatewayId={change === 'gateway' ? 'beta' : 'alpha'}
        observedFingerprint={change === 'fingerprint' ? 'CC' : 'BB'}
        onApprove={() => newApproval} />);
    });
    await act(async () => { void button('Trust new fingerprint').props.onPress(); });
    expect(button('Trust new fingerprint').props.disabled).toBe(true);
    await act(async () => finishOld());
    expect(successHaptics()).not.toHaveBeenCalled();
    expect(button('Trust new fingerprint').props.disabled).toBe(true);
    await act(async () => finishNew());
    expect(successHaptics()).toHaveBeenCalledTimes(1);
    expect(button('Trust new fingerprint').props.disabled).toBe(false);
  });

  test.each(['silent', 'reject'] as const)(
    'a save that lands but a connection that does not (%s) is named as connection failure, not approval success',
    async (connectMode) => {
      mockState.gateways = [savedGateway()];
      mockState.activeId = 'alpha';
      await mount();
      await raisePrompt('http://alpha.test:8642', 'BB');

      mockState.connectMode = connectMode;
      await act(async () => {
        await button('Trust new fingerprint').props.onPress();
      });
      await settle();

      // Persistence succeeded, so the trust decision is settled and the sheet
      // closes; the connection is a separate fact and is reported as such.
      expect(gatewayApi().tlsFingerprintChange).toBeNull();
      expect(mockState.gateways[0]).toMatchObject({
        tlsFingerprint: 'BB',
        tlsFingerprintTrusted: true,
      });
      expect(mockState.connectCalls).toHaveLength(1);
      expect(gatewayApi().status).not.toBe('connected');
      expect(gatewayApi().lastError).toContain('saved, but the gateway did not connect');
      expect(successHaptics()).not.toHaveBeenCalled();
      expect(unhandled).toHaveLength(0);
    },
  );
});
