// ─── Settings: reads that follow the connection, writes that are not claims ──
// Five defects shared one screen, and all five are about the same lie: a control
// or a row asserting something this phone did not establish.
//
//   VOICE-1  `handleVoiceInstall` polled a Gate every 2 s for 30 minutes with no
//            cancellation, so leaving Settings left the chain issuing RPCs and
//            calling setters on a screen that is gone.
//   VOICE-2  the voice-capability read was keyed on `useCallback`s over a
//            provider-stable `gatewayRequest`, so the one read at mount was the
//            only one: a refusal printed until the operator tapped Retry, and a
//            success kept printing "ready" after the Gate was gone.
//   V-2      a storage read that threw inside that effect skipped the
//            `readVoiceCapabilities()` call entirely and left the rows on
//            "Checking this PC…" for the session — with no ErrorCard, so no
//            Retry either.
//   PRIV-1   the widget-privacy writer had `finally { notify }` and no `catch`,
//            and the switch `void`-ed it: a rejected write became an unhandled
//            rejection while the Switch already showed the new value.
//   V-1      the same for the voice-engine row, through `saveAppSettings`.

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

/** Keys the store below refuses the next write for. */
const mockFailKeys = new Set<string>();

jest.mock('@/lib/storage/key-value', () => {
  const store = new Map<string, string>();
  return {
    keyValueStorage: {
      getItem: jest.fn(async (key: string) => store.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        if (mockFailKeys.has(key)) {
          mockFailKeys.delete(key);
          throw new Error('The database is full');
        }
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
    if (mockGateway.saveSettingsFails) throw new Error('The database is full');
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

jest.mock('@/components/ui', () => {
  const { createElement: el } = require('react') as typeof import('react');
  return {
    Badge: 'Badge',
    Card: 'Card',
    ErrorCard: 'ErrorCard',
    Icon: 'Icon',
    PageTitle: 'PageTitle',
    PressableScale: 'PressableScale',
    RowGroup: 'RowGroup',
    // The privacy switches hang off a row's `trailing` slot, and the copy a
    // refusal prints is the row's `detail`, neither of which a host stand-in
    // would draw — so this one draws both.
    RowGroupRow: ({
      title,
      detail,
      trailing,
      children,
    }: {
      title?: string;
      detail?: string;
      trailing?: React.ReactNode;
      children?: React.ReactNode;
    }) =>
      el(
        'RowGroupRow',
        null,
        el('RowGroupTitle', null, title),
        detail === undefined ? null : el('RowGroupDetail', null, detail),
        children,
        trailing,
      ),
    Screen: 'Screen',
    SectionHeader: 'SectionHeader',
    Skeleton: 'Skeleton',
    Text: 'Text',
  };
});
jest.mock('@/components/device-id-row', () => ({ DeviceIdRow: 'DeviceIdRow' }));
jest.mock('@/components/gateway/notifications-section', () => ({
  NotificationsSection: 'NotificationsSection',
}));
jest.mock('@/components/gateway/spend-entry-row', () => ({ SpendEntryRow: 'SpendEntryRow' }));
jest.mock('@/components/gateway/transport-security-card', () => ({
  TransportSecurityCard: 'TransportSecurityCard',
}));
jest.mock('@/components/brand/versutus-mark', () => ({ VersutusMark: 'VersutusMark' }));

// tokens.ts only needs Easing for its Motion curves; reanimated's native
// worklet unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import GatewaySettingsScreen from '@/app/gateway/settings';
import { loadAppSettings, saveAppSettings } from '@/lib/settings/app-settings';
import { DeviceIdentityError } from '@/lib/gateway/errors';
import { pushDeviceParams } from '@/lib/notifications/push-registration';
import { WIDGET_PRIVACY_LABEL } from '@/lib/settings/widget-privacy';
import type { VoiceEngineCapabilities } from '@/lib/voice/voice-engine-choice';

const ERROR_CARD = 'ErrorCard' as unknown as ElementType;
const RADIO_ROW = 'radio' as const;

type Capabilities = VoiceEngineCapabilities;

/** Marks the local engine row without depending on its em dash. */
const LOCAL_ENGINE_MARK = 'Free. Audio stays on your PC';

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
  status: 'disconnected',
  deviceId: 'device-1',
  deviceIdState: 'ready',
  deviceIdError: null as string | null,
  reloadDeviceId: jest.fn(),
  saveSettingsFails: false,
  gatewayRequest: jest.fn(),
};

/** One parked `voice.capabilities` read, released by the test itself. */
const parked = { next: null as Promise<Capabilities> | null };

let renderer: ReactTestRenderer;
let installPolls = 0;

function stringsIn(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(stringsIn);
  if (node && typeof node === 'object' && 'children' in node) {
    return stringsIn((node as { children: unknown }).children);
  }
  return [];
}

function shown(): string[] {
  return stringsIn(renderer.toJSON());
}

/** Everything the screen has drawn, as one string to search. */
function text(): string {
  return shown().join('\n');
}

/** Drain promises and let whatever the screen scheduled come due. */
async function settle(rounds = 12, ms = 1): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }
}

/** Let the install watch's own clock run, so its polls are due. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

function errorCard(): { cause?: string; onRetry?: () => void } | null {
  const card = renderer.root.findAllByType(ERROR_CARD)[0];
  return card ? (card.props as { cause?: string; onRetry?: () => void }) : null;
}

/**
 * The control that owns the handler, found by the props the screen gives it.
 * `Pressable` and `Switch` are matched on their props rather than their type:
 * react-native re-exports them through wrappers, so a type comparison is a
 * detail of the runtime's internals and the props are the contract.
 */
function control(matches: (props: Record<string, unknown>) => boolean): Record<string, unknown> {
  const found = renderer.root.find(
    (node) =>
      typeof node.type !== 'string' &&
      matches((node.props ?? {}) as Record<string, unknown>),
  );
  expect(found).toBeTruthy();
  return found.props as Record<string, unknown>;
}

function switchFor(label: string): { value: boolean; onValueChange: (next: boolean) => void } {
  return control(
    (props) => props.accessibilityLabel === label && typeof props.onValueChange === 'function',
  ) as { value: boolean; onValueChange: (next: boolean) => void };
}

function engineRow(mark: string): { selected: boolean; onPress: () => void } {
  const props = control(
    (candidate) =>
      candidate.accessibilityRole === RADIO_ROW &&
      typeof candidate.accessibilityLabel === 'string' &&
      (candidate.accessibilityLabel as string).includes(mark) &&
      typeof candidate.onPress === 'function',
  );
  return {
    get selected() {
      return (props.accessibilityState as { selected: boolean }).selected;
    },
    onPress: props.onPress as () => void,
  };
}

function installRow(): { onPress: () => void } {
  return control(
    (props) => props.accessibilityLabel === 'Install on this PC' && typeof props.onPress === 'function',
  ) as { onPress: () => void };
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(GatewaySettingsScreen));
  });
  await settle();
}

async function update(): Promise<void> {
  await act(async () => {
    renderer.update(createElement(GatewaySettingsScreen));
  });
  await settle();
}

/** A `voice.install.status` answer, and the polls it has taken. */
function answerInstall(state: 'installing' | 'ready'): void {
  let finished = false;
  mockGateway.gatewayRequest.mockImplementation(async (method: string) => {
    if (method === 'voice.install.status') {
      installPolls += 1;
      if (state !== 'installing') finished = true;
      return { state, reason: state === 'installing' ? 'Downloading 40%…' : undefined };
    }
    if (method === 'voice.capabilities') {
      // The install row only exists while the Gate reports the models missing,
      // and the refresh after the install is what publishes the finished read.
      return capabilities(finished ? READY : NOT_INSTALLED);
    }
    return {};
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockFailKeys.clear();
  installPolls = 0;
  parked.next = null;
  (pushDeviceParams as jest.Mock).mockClear();
  mockGateway.activeGateway = { kind: 'hermes', name: 'Home PC', url: 'http://gate.test' };
  mockGateway.settings = {
    autoConnect: true,
    onboardingComplete: true,
    voiceEngine: 'auto',
    pcName: 'Home PC',
    tailscaleHost: 'home.test',
  };
  mockGateway.status = 'disconnected';
  mockGateway.deviceId = 'device-1';
  mockGateway.deviceIdState = 'ready';
  mockGateway.deviceIdError = null;
  mockGateway.saveSettingsFails = false;
  mockGateway.gatewayRequest.mockReset();
  // The provider refuses before it reaches the network when the Gate is away;
  // the fake mirrors that so the screen sees the same refusal the device does.
  mockGateway.gatewayRequest.mockImplementation(async (method: string) => {
    if (mockGateway.status !== 'connected') throw new Error('Gateway not connected');
    if (method === 'voice.capabilities') return capabilities();
    return {};
  });
  (loadAppSettings as jest.Mock).mockImplementation(async () => ({ ...mockGateway.settings }));
  (saveAppSettings as jest.Mock).mockImplementation(async (patch: Record<string, unknown>) => {
    if (mockGateway.saveSettingsFails) throw new Error('The database is full');
    Object.assign(mockGateway.settings, patch);
    return { ...mockGateway.settings };
  });
  (pushDeviceParams as jest.Mock).mockResolvedValue({ deviceId: 'device-1' });
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

describe('the voice rows follow the connection (VOICE-2)', () => {
  test('mounting offline names the refusal, and connecting clears it without a Retry', async () => {
    await mount();
    expect(text()).toContain("Couldn't check this PC: Gateway not connected");
    expect(errorCard()).not.toBeNull();

    mockGateway.status = 'connected';
    await update();

    // The same refusal is gone, and no read is left claiming to be in flight.
    expect(text()).not.toContain("Couldn't check this PC");
    expect(text()).not.toContain('Checking this PC…');
    expect(errorCard()).toBeNull();
  });

  test('a read that succeeds then loses the connection stops claiming "ready"', async () => {
    mockGateway.status = 'connected';
    mockGateway.gatewayRequest.mockImplementation(async (method: string) => {
      if (mockGateway.status !== 'connected') throw new Error('Gateway not connected');
      if (method === 'voice.capabilities') return capabilities(READY);
      return {};
    });
    await mount();
    expect(text()).toContain('Ready.');

    mockGateway.status = 'reconnecting';
    await update();

    // "Ready." is the Gate's answer, and the Gate is not here any more.
    expect(text()).not.toContain('Ready.');
    expect(text()).toContain("Couldn't check this PC: Gateway not connected");
  });

  test('a slow answer from before the reconnect never lands on the newer read', async () => {
    // The Gate that answered last is the one this phone is talking to. The first
    // read is parked across the status change and answers AFTER the second.
    let releaseParked: (value: Capabilities) => void = () => undefined;
    parked.next = new Promise<Capabilities>((resolve) => {
      releaseParked = resolve;
    });
    mockGateway.gatewayRequest.mockImplementation(async (method: string) => {
      if (method !== 'voice.capabilities') return {};
      if (parked.next) {
        const held = parked.next;
        parked.next = null;
        return held;
      }
      if (mockGateway.status !== 'connected') throw new Error('Gateway not connected');
      return capabilities({ ...READY, usedToday: { localMinutes: 42 } });
    });

    await mount();
    mockGateway.status = 'connected';
    await update();
    expect(text()).toContain('Today: 42 min on this PC');

    // The older read answers now, with an answer from a Gate that is gone.
    await act(async () => {
      releaseParked(capabilities({ usedToday: { localMinutes: 7 } }));
    });
    await settle();

    expect(text()).toContain('Today: 42 min on this PC');
    expect(text()).not.toContain('Today: 7 min on this PC');
  });
});

describe('the voice check always reaches a terminal state (V-2)', () => {
  test('a storage read that throws settles failed, not checking forever', async () => {
    (loadAppSettings as jest.Mock).mockRejectedValueOnce(new Error('AsyncStorage is unavailable'));
    await mount();

    // The screen may never sit on "Checking this PC…": the ErrorCard that offers
    // the Retry only renders once the check has failed, so "checking" here is a
    // wedge with no way out of it.
    expect(text()).toContain("Couldn't check this PC: AsyncStorage is unavailable");
    expect(text()).not.toContain('Checking this PC…');
    expect(errorCard()).not.toBeNull();
  });

  test('the check settles on a refusal too, and Retry re-issues the read', async () => {
    await mount();
    const card = errorCard();
    expect(card).not.toBeNull();

    mockGateway.status = 'connected';
    await act(async () => {
      card?.onRetry?.();
    });
    await settle();

    expect(text()).not.toContain("Couldn't check this PC");
  });
});

describe('the voice install watch cannot outlive the screen (VOICE-1)', () => {
  test('unmounting mid-poll stops every further RPC', async () => {
    mockGateway.status = 'connected';
    answerInstall('installing');
    await mount();

    await act(async () => {
      installRow().onPress();
    });
    await tick(2_500);
    expect(text()).toContain('Installing on this PC…');
    const pollsAtUnmount = installPolls;
    expect(pollsAtUnmount).toBeGreaterThan(0);

    const doomed = renderer;
    renderer = undefined as unknown as ReactTestRenderer;
    await act(async () => {
      doomed.unmount();
    });
    await tick(5 * 60_000);

    // Leaving Settings is the cancellation: the chain used to keep polling for
    // up to thirty minutes against a lossy path with nothing on screen.
    expect(installPolls).toBe(pollsAtUnmount);
  });

  test('the poll backs off instead of hammering the Gate at a fixed two seconds', async () => {
    mockGateway.status = 'connected';
    answerInstall('installing');
    await mount();
    await act(async () => {
      installRow().onPress();
    });
    await settle();

    await tick(2 * 60_000);

    // A fixed 2 s poll is sixty reads in two minutes. The backoff (2 s growing
    // to a 10 s cap) is a handful.
    expect(installPolls).toBeGreaterThan(0);
    expect(installPolls).toBeLessThanOrEqual(15);
  });

  test('the watch hands the wait back after ten minutes and stops polling', async () => {
    mockGateway.status = 'connected';
    answerInstall('installing');
    await mount();
    await act(async () => {
      installRow().onPress();
    });
    await settle();

    await tick(11 * 60_000);

    // A 2 GB download this phone stops watching is still a download the PC
    // finishes: the row says so and stops asking.
    expect(text()).toContain('Still installing on the PC — this phone stopped watching, check back later.');
    expect(text()).not.toContain('Installing on this PC…');
    const pollsAtBudget = installPolls;

    await tick(10 * 60_000);
    expect(installPolls).toBe(pollsAtBudget);
  });

  test('the device params are read once, not once per poll', async () => {
    mockGateway.status = 'connected';
    answerInstall('installing');
    await mount();
    await act(async () => {
      installRow().onPress();
    });
    await tick(2_500);
    const readsAtStart = (pushDeviceParams as jest.Mock).mock.calls.length;

    await tick(2 * 60_000);

    // Reading SecureStore and re-deriving the ed25519 key every poll is phone
    // work for an id that changes only when the identity is re-made.
    expect(installPolls).toBeGreaterThan(0);
    expect((pushDeviceParams as jest.Mock).mock.calls.length).toBe(readsAtStart);
  });

  test('a finished install clears the row and republishes the capabilities', async () => {
    mockGateway.status = 'connected';
    answerInstall('ready');
    await mount();
    await act(async () => {
      installRow().onPress();
    });
    await tick(2_500);

    expect(text()).not.toContain('Installing on this PC…');
    expect(text()).toContain('Ready.');
  });

  test('a refused poll clears the row instead of spinning on it', async () => {
    mockGateway.status = 'connected';
    mockGateway.gatewayRequest.mockImplementation(async (method: string) => {
      if (method === 'voice.capabilities') return capabilities();
      if (method === 'voice.install.status') {
        installPolls += 1;
        throw new Error('Gateway not connected');
      }
      return {};
    });
    await mount();
    await act(async () => {
      installRow().onPress();
    });
    await settle();
    await tick(60_000);

    expect(installPolls).toBe(1);
    expect(text()).not.toContain('Installing on this PC…');
  });

  test('an install the Gate will not start says so and clears the row', async () => {
    mockGateway.status = 'connected';
    mockGateway.gatewayRequest.mockImplementation(async (method: string) => {
      if (method === 'voice.capabilities') return capabilities();
      if (method === 'voice.install.start') throw new Error('voice is disabled on this PC');
      return {};
    });
    await mount();
    await act(async () => {
      installRow().onPress();
    });
    await settle();

    expect(text()).toContain('The Gate could not start the install.');
    expect(installPolls).toBe(0);
  });

  test('an identity this phone cannot give says so, and no rejection escapes the row', async () => {
    mockGateway.status = 'connected';
    await mount();

    // The Gate authorises the download against this phone's identity, and that
    // identity lives in SecureStore: unreadable, there is no install to start,
    // and `pushDeviceParams` rethrows. `onPress` is handed the handler's promise
    // with nothing attached to it, so awaiting it here IS the unhandled
    // rejection when the read is bare.
    (pushDeviceParams as jest.Mock).mockRejectedValue(new DeviceIdentityError('the keychain is locked'));
    await act(async () => {
      await installRow().onPress();
    });
    await settle();

    expect(text()).toContain('This phone could not make its device identity, so the Gate could not start the install.');
    // The row may not keep the note it wrote before the download began.
    expect(text()).not.toContain('Downloading the PC voice models…');
    expect(text()).not.toContain('Installing on this PC…');
    expect(installPolls).toBe(0);
  });

  test('leaving the screen leaves the poll clock behind for nobody', async () => {
    mockGateway.status = 'connected';
    answerInstall('installing');
    const setSpy = jest.spyOn(global, 'setTimeout');
    const clearSpy = jest.spyOn(global, 'clearTimeout');
    await mount();
    await act(async () => {
      installRow().onPress();
    });
    await tick(2_500);

    // The watch is parked on its backoff wait. The poll's waits are the only
    // long clocks here — React's own act bookkeeping asks for a 0 ms one — so
    // the timer it is parked on is the last of them.
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    const parked = setSpy.mock.calls
      .map((call, index) => ({ delay: call[1] ?? 0, timer: setSpy.mock.results[index].value }))
      .filter((entry) => entry.delay >= 2_000)
      .map((entry) => entry.timer);
    expect(parked.length).toBeGreaterThan(0);

    const doomed = renderer;
    renderer = undefined as unknown as ReactTestRenderer;
    await act(async () => {
      doomed.unmount();
    });

    // The poll stops on the abort, so the timer that was going to wake it goes
    // with the screen rather than firing into a chain nobody is watching. An
    // `act` unmount leaves bookkeeping of its own pending, which is why this
    // names the timer instead of counting what is left.
    expect(clearSpy.mock.calls.map((call) => call[0])).toContain(parked[parked.length - 1]);
  });
});

describe('a preference the phone could not store is never claimed (PRIV-1, V-1)', () => {
  test('the widget switch goes back to the stored value when the write is refused', async () => {
    await mount();
    expect(switchFor(WIDGET_PRIVACY_LABEL).value).toBe(false);

    mockFailKeys.add('versutus:widget-result-hidden');
    await act(async () => {
      switchFor(WIDGET_PRIVACY_LABEL).onValueChange(true);
    });
    await settle();

    // The Switch has already moved by the time the write settles, so a refused
    // write has to put it back and name the refusal on the row.
    expect(switchFor(WIDGET_PRIVACY_LABEL).value).toBe(false);
    expect(text()).toContain('This phone could not store that preference, so it is not kept.');
  });

  test('a stored widget preference stays selected', async () => {
    await mount();
    await act(async () => {
      switchFor(WIDGET_PRIVACY_LABEL).onValueChange(true);
    });
    await settle();

    expect(switchFor(WIDGET_PRIVACY_LABEL).value).toBe(true);
    expect(text()).not.toContain('This phone could not store that preference');
  });

  test('the voice-engine row goes back to the stored engine when the write is refused', async () => {
    mockGateway.status = 'connected';
    await mount();
    expect(engineRow(LOCAL_ENGINE_MARK).selected).toBe(false);

    mockGateway.saveSettingsFails = true;
    await act(async () => {
      engineRow(LOCAL_ENGINE_MARK).onPress();
    });
    await settle();

    // The radio put itself on an engine this phone did not manage to store, so
    // it goes back to the one that IS stored and says why.
    expect(engineRow(LOCAL_ENGINE_MARK).selected).toBe(false);
    expect(text()).toContain('This phone could not store that choice, so it is not kept.');
    expect(saveAppSettings).toHaveBeenCalledWith({ voiceEngine: 'local' });
  });

  test('a stored engine choice stays selected', async () => {
    mockGateway.status = 'connected';
    await mount();
    await act(async () => {
      engineRow(LOCAL_ENGINE_MARK).onPress();
    });
    await settle();

    expect(engineRow(LOCAL_ENGINE_MARK).selected).toBe(true);
    expect(text()).not.toContain('This phone could not store that choice');
    expect(mockGateway.settings.voiceEngine).toBe('local');
  });
});

describe('the engine row follows the connection without undoing a press', () => {
  test('a connection edge mid-write leaves the row on the engine being stored', async () => {
    mockGateway.status = 'connected';
    await mount();
    expect(engineRow(LOCAL_ENGINE_MARK).selected).toBe(false);

    // The write is parked across the connection edge, so the stored blob this
    // edge re-reads is still the pre-write one. Asserting it puts the row back
    // on an engine the store does not hold, and the write's own success path
    // never puts it forward again — so the screen would name a stale engine for
    // the rest of the session.
    let releaseWrite: () => void = () => undefined;
    const parkedWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    (saveAppSettings as jest.Mock).mockImplementationOnce(async (patch: Record<string, unknown>) => {
      await parkedWrite;
      Object.assign(mockGateway.settings, patch);
      return { ...mockGateway.settings };
    });

    await act(async () => {
      engineRow(LOCAL_ENGINE_MARK).onPress();
    });
    await settle();
    expect(engineRow(LOCAL_ENGINE_MARK).selected).toBe(true);

    mockGateway.status = 'reconnecting';
    await update();
    mockGateway.status = 'connected';
    await update();

    expect(engineRow(LOCAL_ENGINE_MARK).selected).toBe(true);

    // And once the write lands, the row and the store agree.
    await act(async () => {
      releaseWrite();
    });
    await settle();

    expect(engineRow(LOCAL_ENGINE_MARK).selected).toBe(true);
    expect(mockGateway.settings.voiceEngine).toBe('local');
    expect(text()).not.toContain('This phone could not store that choice');
  });
});
