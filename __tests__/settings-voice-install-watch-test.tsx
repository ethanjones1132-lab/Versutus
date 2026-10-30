// ─── VS-004: a lost status poll may not become a second download ──────────────
// The install watch starts `voice.install.start` once and then follows
// `voice.install.status`. One rejected status read used to abandon the watch
// while the row still said "Downloading…", and the start row came back — over a
// download the PC was still running. The contract the watch actually has:
//
//   { state: 'installing', reason? }   keep following
//   { state: 'ready' }                 done; the start offer goes away
//   { state: 'not-installed' | 'unavailable', reason }
//                                      terminal; an explicit start is honest
//
// A transient failure is retried inside the existing backoff and budget with
// the SAME params. When the watch stops without a terminal answer (budget, or a
// refusal it cannot retry) the row offers only a status CHECK, never a start.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light' },
}));
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));
jest.mock('expo-router', () => ({
  Link: 'Link',
  useRouter: () => ({
    canGoBack: () => true,
    back: jest.fn(),
    replace: jest.fn(),
    push: jest.fn(),
  }),
}));

jest.mock('@/lib/storage/key-value', () => {
  const store = new Map<string, string>();
  return {
    keyValueStorage: {
      getItem: jest.fn(async (key: string) => store.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: jest.fn(async (key: string) => {
        store.delete(key);
      }),
    },
  };
});

jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => mockGateway,
}));

jest.mock('@/lib/settings/app-settings', () => ({
  loadAppSettings: jest.fn(async () => ({ ...mockGateway.settings })),
  saveAppSettings: jest.fn(async (patch: Record<string, unknown>) => {
    Object.assign(mockGateway.settings, patch);
    return { ...mockGateway.settings };
  }),
}));

jest.mock('@/lib/notifications/push-registration', () => ({
  pushDeviceParams: jest.fn(async () => ({ deviceId: 'device-1' })),
}));

jest.mock('@/lib/gateway/approval-policy', () => ({
  approvalAuditCopy: () => 'a decision',
  approvalAuditSummaryCopy: (count: number) => `${count} decisions`,
  loadApprovalAudit: jest.fn(async () => []),
}));

jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({
    scheme: 'dark',
    background: '#000',
    backgroundRaised: '#111',
    accent: '#0af',
    accentDeep: '#08f',
    accentMuted: '#00f2',
    textPrimary: '#fff',
    textSecondary: '#aaa',
    textTertiary: '#777',
    statusConnected: '#0f0',
  }),
}));

jest.mock('@/components/ui', () => ({
  Badge: 'Badge',
  Card: 'Card',
  ErrorCard: 'ErrorCard',
  Icon: 'Icon',
  PageTitle: 'PageTitle',
  PressableScale: 'PressableScale',
  RowGroup: 'RowGroup',
  RowGroupRow: 'RowGroupRow',
  Screen: 'Screen',
  SectionHeader: 'SectionHeader',
  Skeleton: 'Skeleton',
  Text: 'Text',
}));
jest.mock('@/components/device-id-row', () => ({ DeviceIdRow: 'DeviceIdRow' }));
jest.mock('@/components/gateway/notifications-section', () => ({
  NotificationsSection: 'NotificationsSection',
}));
jest.mock('@/components/gateway/spend-entry-row', () => ({ SpendEntryRow: 'SpendEntryRow' }));
jest.mock('@/components/gateway/transport-security-card', () => ({
  TransportSecurityCard: 'TransportSecurityCard',
}));
jest.mock('@/components/brand/versutus-mark', () => ({ VersutusMark: 'VersutusMark' }));

jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import GatewaySettingsScreen from '@/app/gateway/settings';
import { DeviceIdentityError, GatewayHttpError } from '@/lib/gateway/errors';
import { pushDeviceParams } from '@/lib/notifications/push-registration';
import type { VoiceEngineCapabilities } from '@/lib/voice/voice-engine-choice';

type Capabilities = VoiceEngineCapabilities;

const NOT_INSTALLED = {
  engines: {
    local: { state: 'not-installed' as const, reason: 'The PC voice models are not installed yet.' },
    codex: { state: 'unavailable' as const },
  },
};

const READY = {
  engines: { local: { state: 'ready' as const }, codex: { state: 'unavailable' as const } },
};

function capabilities(overrides: Partial<Capabilities> = {}): Capabilities {
  return { enabled: true, ...NOT_INSTALLED, ...overrides };
}

const mockGateway = {
  activeGateway: { kind: 'hermes', name: 'Home PC', url: 'http://gate.test' } as {
    kind: string;
    name: string;
    url: string;
  } | null,
  settings: {
    autoConnect: true,
    onboardingComplete: true,
    voiceEngine: 'auto' as string,
    pcName: 'Home PC',
    tailscaleHost: 'home.test',
  },
  status: 'connected',
  deviceId: 'device-1',
  deviceIdState: 'ready',
  deviceIdError: null as string | null,
  reloadDeviceId: jest.fn(),
  gatewayRequest: jest.fn(),
};

let renderer: ReactTestRenderer;

function stringsIn(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(stringsIn);
  if (node && typeof node === 'object' && 'children' in node) {
    return stringsIn((node as { children: unknown }).children);
  }
  return [];
}

/** Everything the screen has drawn, as one string to search. */
function text(): string {
  return stringsIn(renderer.toJSON()).join('\n');
}

/** Drain promises and let whatever the screen scheduled come due. */
async function settle(rounds = 12, ms = 1): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }
}

/** Let the install watch's own clock run, so its waits are due. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

/** The control the screen gives this accessibility label, if it is drawn. */
function control(label: string): { onPress: () => unknown } | null {
  const found = renderer.root.findAll(
    (node) =>
      typeof node.type !== 'string' &&
      ((node.props ?? {}) as Record<string, unknown>).accessibilityLabel === label &&
      typeof ((node.props ?? {}) as Record<string, unknown>).onPress === 'function',
  );
  return found.length === 0 ? null : (found[0].props as { onPress: () => unknown });
}

/** Every request the screen has sent for one RPC, with its params. */
function callsTo(method: string): { params?: { deviceId?: string } }[] {
  return mockGateway.gatewayRequest.mock.calls
    .filter((call) => call[0] === method)
    .map((call) => ({ params: call[1] as { deviceId?: string } | undefined }));
}

async function press(label: string): Promise<void> {
  const row = control(label);
  expect(row).not.toBeNull();
  await act(async () => {
    void row?.onPress();
  });
  await settle();
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(GatewaySettingsScreen));
  });
  await settle();
}

beforeEach(() => {
  jest.useFakeTimers();
  (pushDeviceParams as jest.Mock).mockReset();
  (pushDeviceParams as jest.Mock).mockResolvedValue({ deviceId: 'device-1' });
  mockGateway.status = 'connected';
  mockGateway.gatewayRequest.mockReset();
  // The Gate is there, has no PC models, and says nothing else until a test
  // gives the install RPCs their own answers.
  mockGateway.gatewayRequest.mockImplementation(async (method: string) => {
    if (mockGateway.status !== 'connected') throw new Error('Gateway not connected');
    if (method === 'voice.capabilities') return capabilities();
    return {};
  });
});

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = undefined as unknown as ReactTestRenderer;
    await act(async () => {
      doomed.unmount();
    });
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('a lost status poll never becomes a second install', () => {
  test.each([
    ['a lost start acknowledgement', new Error('Network request failed')],
    ['an install already running on the PC', new GatewayHttpError('A voice install is already running.', 409)],
  ])('%s offers a status check instead of a second start', async (_label, startError) => {
    mockGateway.gatewayRequest.mockImplementation(async (method: string) => {
      if (method === 'voice.capabilities') return capabilities();
      // The PC accepted the install, but its acknowledgement was lost.
      if (method === 'voice.install.start') throw startError;
      if (method === 'voice.install.status') return { state: 'installing', reason: 'Downloading 40%…' };
      return {};
    });

    await mount();
    await press('Install on this PC');
    expect(callsTo('voice.install.start')).toHaveLength(1);
    expect(control('Install on this PC')).toBeNull();
    expect(control('Check the install on this PC')).not.toBeNull();

    await press('Check the install on this PC');
    await tick(2_500);
    expect(callsTo('voice.install.status')).toHaveLength(1);
    expect(callsTo('voice.install.start')).toHaveLength(1);
    expect(text()).toContain('Downloading 40%…');
  });

  test('one failure retries the same install, with exactly one start', async () => {
    let polls = 0;
    let finished = false;
    mockGateway.gatewayRequest.mockImplementation(async (method: string) => {
      if (mockGateway.status !== 'connected') throw new Error('Gateway not connected');
      if (method === 'voice.capabilities') {
        return capabilities(finished ? READY : NOT_INSTALLED);
      }
      if (method === 'voice.install.start') return { state: 'installing' };
      if (method === 'voice.install.status') {
        polls += 1;
        if (polls === 1) throw new Error('Network request failed');
        if (polls === 2) return { state: 'installing', reason: 'Downloading 40%…' };
        finished = true;
        return { state: 'ready' };
      }
      return {};
    });

    await mount();
    await press('Install on this PC');

    // The first poll dies at 2 s. The watch keeps the install it started, names
    // the lost contact, and does not put the start row back in front of the
    // operator over a download that may still be running.
    await tick(2_500);
    expect(callsTo('voice.install.status')).toHaveLength(1);
    expect(text()).toContain('Lost contact with the Gate — still checking this install…');
    expect(text()).toContain('Installing on this PC…');
    expect(control('Install on this PC')).toBeNull();

    // The retry rides the existing backoff (2 s then 4 s) and reads the SAME
    // install with the same identity.
    await tick(4_500);
    expect(polls).toBe(2);
    expect(text()).toContain('Downloading 40%…');
    expect(text()).toContain('Installing on this PC…');

    // The install finishes, and the start offer is not there to be pressed.
    await tick(8_500);
    expect(text()).toContain('Ready.');
    expect(text()).not.toContain('Installing on this PC…');
    expect(control('Install on this PC')).toBeNull();

    expect(callsTo('voice.install.start')).toHaveLength(1);
    expect(
      callsTo('voice.install.status').every((call) => call.params?.deviceId === 'device-1'),
    ).toBe(true);
  });

  test('repeated failures stay bounded and offer only a status check', async () => {
    mockGateway.gatewayRequest.mockImplementation(async (method: string) => {
      if (mockGateway.status !== 'connected') throw new Error('Gateway not connected');
      if (method === 'voice.capabilities') return capabilities();
      if (method === 'voice.install.start') return { state: 'installing' };
      if (method === 'voice.install.status') {
        // A Gate that answers but cannot serve the read: retryable, not a
        // verdict about the install.
        throw new GatewayHttpError('The Gate is restarting', 503);
      }
      return {};
    });

    await mount();
    await press('Install on this PC');
    await tick(60_000);

    const pollsInFirstMinute = callsTo('voice.install.status').length;
    expect(pollsInFirstMinute).toBeGreaterThan(1);
    // Backoff, not a fixed two-second hammer: a minute of failures is a handful
    // of reads, and the watch still says what it has lost.
    expect(pollsInFirstMinute).toBeLessThanOrEqual(10);
    expect(text()).toContain('Lost contact with the Gate — still checking this install…');
    expect(text()).toContain('Installing on this PC…');
    expect(control('Install on this PC')).toBeNull();

    await tick(10 * 60_000);
    expect(text()).toContain('Still installing on the PC — this phone stopped watching, check back later.');
    expect(text()).not.toContain('Installing on this PC…');
    const pollsAtBudget = callsTo('voice.install.status').length;
    // Bounded by the existing ten-minute budget: 2 s, 4 s, 8 s, then the 10 s
    // cap. The failures never make the watch poll faster or run longer.
    expect(pollsAtBudget).toBeLessThanOrEqual(70);
    expect(control('Install on this PC')).toBeNull();

    // The only recovery is a status check on the install that may still be
    // running. It must not ask the Gate to begin another download.
    await press('Check the install on this PC');
    await tick(2_500);
    expect(callsTo('voice.install.status')).toHaveLength(pollsAtBudget + 1);
    expect(callsTo('voice.install.start')).toHaveLength(1);
    expect(text()).toContain('Following the install on this PC…');
    expect(control('Install on this PC')).toBeNull();
  });

  test('a confirmed ready removes the offer even when the closing read is refused', async () => {
    let reads = 0;
    mockGateway.gatewayRequest.mockImplementation(async (method: string) => {
      if (mockGateway.status !== 'connected') throw new Error('Gateway not connected');
      if (method === 'voice.capabilities') {
        reads += 1;
        // The mount read says the models are missing; the read after the install
        // is refused, so the capabilities this screen holds stay stale.
        if (reads === 1) return capabilities();
        throw new Error('Network request failed');
      }
      if (method === 'voice.install.start') return { state: 'installing' };
      if (method === 'voice.install.status') return { state: 'ready' };
      return {};
    });

    await mount();
    expect(control('Install on this PC')).not.toBeNull();

    await press('Install on this PC');
    await tick(2_500);

    expect(callsTo('voice.install.status')).toHaveLength(1);
    expect(text()).not.toContain('Installing on this PC…');
    // The stale "not-installed" capabilities would re-offer the install; the
    // confirmed ready answer is what keeps the row away.
    expect(control('Install on this PC')).toBeNull();
    expect(control('Check the install on this PC')).toBeNull();
    expect(text()).not.toContain('Downloading the PC voice models…');
  });

  test('leaving the screen retires the wait and a late answer resumes nothing', async () => {
    let release: (value: { state: string }) => void = () => undefined;
    const parked = new Promise<{ state: string }>((resolve) => {
      release = resolve;
    });
    mockGateway.gatewayRequest.mockImplementation(async (method: string) => {
      if (mockGateway.status !== 'connected') throw new Error('Gateway not connected');
      if (method === 'voice.capabilities') return capabilities();
      if (method === 'voice.install.start') return { state: 'installing' };
      if (method === 'voice.install.status') return parked;
      return {};
    });

    await mount();
    await press('Install on this PC');
    await tick(2_500);
    const requestsBeforeUnmount = mockGateway.gatewayRequest.mock.calls.length;
    expect(callsTo('voice.install.status')).toHaveLength(1);

    const setSpy = jest.spyOn(global, 'setTimeout');
    const doomed = renderer;
    renderer = undefined as unknown as ReactTestRenderer;
    await act(async () => {
      doomed.unmount();
    });

    // The answer arrives after the screen is gone. It may not keep following,
    // refresh capabilities, or park the watch on another wait.
    await act(async () => {
      release({ state: 'installing' });
    });
    await tick(10 * 60_000);

    expect(mockGateway.gatewayRequest.mock.calls.length).toBe(requestsBeforeUnmount);
    // The late answer did not park the watch on another backoff wait.
    expect(setSpy.mock.calls.filter((call) => (call[1] ?? 0) >= 2_000)).toHaveLength(0);
    setSpy.mockRestore();
  });

  test('unmounting while parked on a wait clears that wait', async () => {
    mockGateway.gatewayRequest.mockImplementation(async (method: string) => {
      if (mockGateway.status !== 'connected') throw new Error('Gateway not connected');
      if (method === 'voice.capabilities') return capabilities();
      if (method === 'voice.install.start') return { state: 'installing' };
      if (method === 'voice.install.status') {
        return { state: 'installing', reason: 'Downloading 10%…' };
      }
      return {};
    });
    const setSpy = jest.spyOn(global, 'setTimeout');
    const clearSpy = jest.spyOn(global, 'clearTimeout');

    await mount();
    await press('Install on this PC');
    // The poll answers at 2 s, so the watch is now parked on its 4 s wait.
    await tick(2_500);
    const waits = setSpy.mock.calls
      .map((call, index) => ({ delay: call[1] ?? 0, timer: setSpy.mock.results[index].value }))
      .filter((entry) => entry.delay >= 2_000)
      .map((entry) => entry.timer);
    expect(waits.length).toBeGreaterThan(0);

    const doomed = renderer;
    renderer = undefined as unknown as ReactTestRenderer;
    await act(async () => {
      doomed.unmount();
    });

    // The screen owns the clock: the wait it was parked on is cleared with it,
    // rather than waking the JS thread for a poll nobody will see.
    expect(clearSpy.mock.calls.map((call) => call[0])).toContain(waits[waits.length - 1]);
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });
});

describe('the watch keeps the identity rule and never restarts the install', () => {
  test('an auth refusal refreshes the device params once and keeps following', async () => {
    let refreshed = false;
    let polls = 0;
    const seenDeviceIds: string[] = [];
    (pushDeviceParams as jest.Mock).mockImplementation(async () =>
      refreshed ? { deviceId: 'device-2' } : { deviceId: 'device-1' },
    );
    mockGateway.gatewayRequest.mockImplementation(
      async (method: string, params?: { deviceId?: string }) => {
        if (mockGateway.status !== 'connected') throw new Error('Gateway not connected');
        if (method === 'voice.capabilities') return capabilities();
        if (method === 'voice.install.start') {
          seenDeviceIds.push(params?.deviceId ?? 'missing');
          return { state: 'installing' };
        }
        if (method === 'voice.install.status') {
          polls += 1;
          seenDeviceIds.push(params?.deviceId ?? 'missing');
          if (polls === 1) {
            // The Gate will not take this name; the watch may mint a new one.
            refreshed = true;
            throw new GatewayHttpError('Unauthorized', 401);
          }
          return { state: 'installing', reason: 'Downloading 60%…' };
        }
        return {};
      },
    );

    await mount();
    const readsAtMount = (pushDeviceParams as jest.Mock).mock.calls.length;
    await press('Install on this PC');
    await tick(2_500);

    // One read for the start, one for the documented refresh: the poll itself
    // does not re-derive the identity.
    expect((pushDeviceParams as jest.Mock).mock.calls.length).toBe(readsAtMount + 2);
    expect(text()).not.toContain('Lost contact with the Gate');

    await tick(4_500);
    expect(polls).toBe(2);
    expect(seenDeviceIds).toEqual(['device-1', 'device-1', 'device-2']);
    expect(callsTo('voice.install.start')).toHaveLength(1);
    expect(text()).toContain('Downloading 60%…');
  });

  test('a named 4xx refusal stops even when its message looks like a dropped call', async () => {
    mockGateway.gatewayRequest.mockImplementation(async (method: string) => {
      if (mockGateway.status !== 'connected') throw new Error('Gateway not connected');
      if (method === 'voice.capabilities') return capabilities();
      if (method === 'voice.install.start') return { state: 'installing' };
      if (method === 'voice.install.status') {
        throw new GatewayHttpError('upstream connection reset', 409);
      }
      return {};
    });

    await mount();
    await press('Install on this PC');
    await tick(60_000);

    // One answer is the verdict. The watch must not spend the budget re-polling
    // a request the Gate refused, and it must not offer a second download.
    expect(callsTo('voice.install.status')).toHaveLength(1);
    expect(callsTo('voice.install.start')).toHaveLength(1);
    expect(control('Install on this PC')).toBeNull();
    expect(control('Check the install on this PC')).not.toBeNull();
    expect(text()).toContain("Couldn't check this install: upstream connection reset");
  });

  test('a refused identity refresh stops following with no start offered', async () => {
    let reads = 0;
    (pushDeviceParams as jest.Mock).mockImplementation(async () => {
      reads += 1;
      // The mount read and the start's read succeed; the refresh after the
      // Gate's refusal is the one this phone cannot make.
      if (reads >= 3) throw new DeviceIdentityError('the keychain is locked');
      return { deviceId: 'device-1' };
    });
    mockGateway.gatewayRequest.mockImplementation(async (method: string) => {
      if (mockGateway.status !== 'connected') throw new Error('Gateway not connected');
      if (method === 'voice.capabilities') return capabilities();
      if (method === 'voice.install.start') return { state: 'installing' };
      if (method === 'voice.install.status') throw new GatewayHttpError('Unauthorized', 401);
      return {};
    });

    await mount();
    await press('Install on this PC');
    await tick(2_500);

    expect(text()).toContain(
      'This phone could not refresh its device identity, so it stopped checking the install.',
    );
    expect(callsTo('voice.install.status')).toHaveLength(1);
    expect(callsTo('voice.install.start')).toHaveLength(1);
    // The install's outcome is still unknown, so the row may not re-offer it.
    expect(control('Install on this PC')).toBeNull();
  });
});
