/**
 * VS-078 — a call link's engine belongs to that one call.
 *
 * `versutus://call?engine=local|codex|phone|auto` opens the sheet with that
 * engine selected, while the saved `voiceEngine` is left exactly as it was: the
 * link is an override, never a preference. A call opened without a link — the
 * composer's own Call control, the launcher shortcut that names no engine — is
 * still decided by the stored preference.
 *
 * Nothing reaches the network: the gateway and the handsfree provider are the
 * seams, exactly as they are on the device.
 */
import { createElement, type ElementType, type ReactNode } from 'react';

jest.mock('react-native-reanimated', () => {
  const chain = {
    duration: () => chain,
    easing: () => chain,
    delay: () => chain,
    withInitialValues: () => chain,
    springify: () => chain,
  };
  const Keyframe = function KeyframeStub() {
    return chain;
  } as unknown as new () => unknown;
  return {
    __esModule: true,
    default: { View: 'AnimatedView' },
    Keyframe,
    Easing: {
      bezier: () => (value: number) => value,
      elastic: () => (value: number) => value,
      cubic: (value: number) => value,
      ease: (value: number) => value,
      inOut: (fn: unknown) => fn,
      out: (fn: unknown) => fn,
      linear: (value: number) => value,
    },
    FadeIn: chain,
    FadeInDown: chain,
    FadeOut: chain,
    FadeOutDown: chain,
    Layout: chain,
    useAnimatedStyle: () => ({}),
    useSharedValue: (value: unknown) => ({ value }),
    useDerivedValue: (compute: () => number) => compute(),
    withRepeat: () => undefined,
    withTiming: () => undefined,
  };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, top: 0, left: 0, right: 0 }),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
const focusEffects: (() => unknown)[] = [];
/** The route params the screen reads; a `versutus://call` link sets `call: '1'`. */
let mockRouteParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useFocusEffect: (effect: () => unknown) => {
    focusEffects.push(effect);
  },
  useIsFocused: () => true,
  useLocalSearchParams: () => mockRouteParams,
  useNavigation: () => ({ dispatch: jest.fn() }),
}));
jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({
    accent: '#0af',
    accentMuted: '#00f2',
    backgroundInset: '#111',
    backgroundElevated: '#111',
    border: '#333',
    borderSubtle: '#222',
    textPrimary: '#fff',
    textTertiary: '#777',
    statusConnected: '#0f0',
  }),
}));
jest.mock('@/lib/motion/ambient-parallax', () => ({
  useAmbientParallaxScroll: () => ({ parallaxY: { value: 0 }, onScroll: jest.fn() }),
}));
jest.mock('@/hooks/use-crest-fleet', () => ({ useBotCrest: () => ({ tone: 'violet' }) }));
const mockDeviceSpeech = { voices: [{ identifier: 'en-GB-Samantha' }] as unknown[] };
jest.mock('@/lib/voice/speech', () => ({
  availableVoices: jest.fn(async () => mockDeviceSpeech.voices),
  speechAvailableFrom: () => mockDeviceSpeech.voices.length > 0,
  speakReply: jest.fn(async () => undefined),
  stopSpeech: jest.fn(async () => undefined),
}));
jest.mock('@/lib/notifications/push-registration', () => ({
  pushDeviceParams: jest.fn(async () => ({ platform: 'android' })),
}));
jest.mock('@/lib/notifications/routine-sync', () => ({
  cancelRoutineNotification: jest.fn(async () => undefined),
  rearmRoutineNotifications: jest.fn(async () => undefined),
  syncRoutineNotification: jest.fn(async () => undefined),
}));
jest.mock('@/lib/gateway/session-analytics', () => ({
  ...jest.requireActual('@/lib/gateway/session-analytics'),
  readBotSpend: jest.fn(async () => null),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true })),
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true, assets: null })),
}));
jest.mock('@/lib/haptics', () => ({
  haptics: { light: jest.fn(async () => undefined), success: jest.fn(async () => undefined) },
}));

jest.mock('@/components/ui', () => ({
  Badge: 'Badge',
  Button: 'Button',
  Card: 'Card',
  EmptyState: 'EmptyState',
  ErrorCard: 'ErrorCard',
  Icon: 'Icon',
  PageTitle: 'PageTitle',
  PressableScale: 'PressableScale',
  Screen: 'Screen',
  SectionHeader: 'SectionHeader',
  Skeleton: 'Skeleton',
  Text: 'Text',
  TextField: 'TextField',
}));

const passthrough = (name: string) => {
  const Host = ({ children }: { children?: ReactNode }) => children ?? null;
  Host.displayName = name;
  return Host;
};
jest.mock('@/components/chat/chat-composer', () => ({ ChatComposer: 'ChatComposer' }));
jest.mock('@/components/chat/chat-roster', () => ({ ChatRoster: 'ChatRoster' }));
jest.mock('@/components/chat/chat-header', () => ({ ChatHeader: 'ChatHeader' }));
jest.mock('@/components/chat/message-bubble', () => ({ MessageBubble: 'MessageBubble' }));
jest.mock('@/components/chat/bot-chrome', () => ({ BotChrome: 'BotChrome' }));
jest.mock('@/components/chat/bot-panel-sheet', () => ({ BotPanelSheet: passthrough('BotPanelSheet') }));
jest.mock('@/components/chat/handsfree-call-sheet', () => ({ HandsfreeCallSheet: 'HandsfreeCallSheet' }));
jest.mock('@/components/chat/chat-overflow-sheet', () => ({ ChatOverflowSheet: 'ChatOverflowSheet' }));
jest.mock('@/components/chat/thread-config-sheet', () => ({ ThreadConfigSheet: 'ThreadConfigSheet' }));
jest.mock('@/components/chat/new-agent-sheet', () => ({ NewAgentSheet: 'NewAgentSheet' }));
jest.mock('@/components/chat/approval-sheet', () => ({ ApprovalSheet: 'ApprovalSheet' }));
jest.mock('@/components/chat/bot-detail-sheet', () => ({ BotDetailSheet: 'BotDetailSheet' }));
jest.mock('@/components/chat/create-group-sheet', () => ({ CreateGroupSheet: 'CreateGroupSheet' }));
jest.mock('@/components/chat/group-room-action-sheet', () => ({
  GroupRoomActionSheet: 'GroupRoomActionSheet',
}));
jest.mock('@/components/chat/message-actions-sheet', () => ({
  MessageActionsSheet: 'MessageActionsSheet',
}));
jest.mock('@/components/chat/pairing-sheet', () => ({ PairingSheet: 'PairingSheet' }));
jest.mock('@/components/chat/confirmation-sheet', () => ({ ConfirmationSheet: 'ConfirmationSheet' }));
jest.mock('@/components/chat/slash-command-palette', () => ({
  SlashCommandPalette: 'SlashCommandPalette',
}));
jest.mock('@/components/chat/thread-spend-glance', () => ({ ThreadSpendGlance: 'ThreadSpendGlance' }));
jest.mock('@/components/chat/skills-pane', () => ({ SkillsPane: 'SkillsPane' }));
jest.mock('@/components/chat/tools-pane', () => ({ ToolsPane: 'ToolsPane' }));
jest.mock('@/components/chat/routines-pane', () => ({ RoutinesPane: 'RoutinesPane' }));
jest.mock('@/components/chat/day-divider', () => ({ DayDivider: 'DayDivider' }));
jest.mock('@/components/chat/chat-empty-state', () => ({ ChatEmptyState: 'ChatEmptyState' }));
jest.mock('@/components/chat/thread-welcome', () => ({ ThreadWelcome: 'ThreadWelcome' }));
jest.mock('@/components/avatar/look-studio-sheet', () => ({ LookStudioSheet: 'LookStudioSheet' }));
jest.mock('@/components/chat/group-room-view', () => ({ GroupRoomView: 'GroupRoomView' }));
jest.mock('@/lib/diagnostics/failure-log', () => ({
  recordFailure: jest.fn(),
  loadFailures: jest.fn(async () => []),
}));

const mockGateway: Record<string, unknown> = {};
const mockSurface = { messages: [] as unknown[], isSending: false, isCommandRunning: false };
/** The target each start was handed; the mock needs a shape to read it back. */
type MockCallTarget = { transport?: string; voiceEngine?: string };
let startedTarget: MockCallTarget | undefined;
let mockStoredTransport: 'phone' | 'gate';
const mockStart = jest.fn();

jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => mockGateway,
  useChatSurface: () => mockSurface,
}));
jest.mock('@/context/handsfree-voice-provider', () => ({
  useHandsfreeVoice: () => ({
    active: false,
    canStart: true,
    transport: mockStoredTransport,
    start: mockStart,
    end: jest.fn(),
    startBlocker: undefined,
    callsEnded: 0,
    lastEndReason: undefined,
  }),
}));

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Platform } from 'react-native';

import { ChatScreen } from '@/components/chat/chat-screen';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadAppSettings, saveAppSettings } from '@/lib/settings/app-settings';

const COMPOSER = 'ChatComposer' as ElementType;
const ROSTER = 'ChatRoster' as ElementType;
const CALL_SHEET = 'HandsfreeCallSheet' as ElementType;

const GATEWAY = { id: 'gw-1', name: 'Home PC', url: 'http://gate.test', kind: 'hermes', model: 'vision-1' };

/** The labels the sheet shows for the two PC engines it can resolve here. */
const LOCAL_LABEL = 'This PC';
const CODEX_LABEL = 'ChatGPT on this PC';

/** Both PC engines are ready, so the label names the engine the open asked for. */
const CAPABILITIES = {
  enabled: true,
  engines: {
    local: { state: 'ready' },
    codex: { state: 'ready' },
  },
};

function reset(patch: Record<string, unknown> = {}): void {
  Object.assign(mockGateway, {
    activeGateway: GATEWAY,
    settings: { pcName: 'Home PC' },
    status: 'connected',
    statusDetail: undefined,
    connectionPhase: 'connected',
    probeMessage: undefined,
    lastError: null,
    clearLastError: jest.fn(),
    deviceId: 'dev-1',
    pairingDetails: null,
    sendChatInput: jest.fn(async () => 'sent' as string),
    activeHello: null,
    reloadHistory: jest.fn(async () => undefined),
    retryAutoConnect: jest.fn(async () => undefined),
    retryCommand: jest.fn(),
    cancelCommand: jest.fn(),
    pendingConfirmation: null,
    confirmPendingAction: jest.fn(),
    cancelPendingConfirmation: jest.fn(),
    modelPicker: { visible: false },
    openModelPicker: jest.fn(),
    closeModelPicker: jest.fn(),
    stopStreaming: jest.fn(),
    selectModel: jest.fn(),
    clearModelLock: jest.fn(),
    modelCatalog: [] as unknown[],
    modelCatalogError: undefined,
    modelCatalogLoaded: false,
    sessionSelector: { visible: false },
    openSessionSelector: jest.fn(),
    closeSessionSelector: jest.fn(),
    selectSession: jest.fn(),
    sessionList: [],
    sessionListError: undefined,
    sessionListLoaded: true,
    sessionListHasOlder: false,
    loadingOlderSessions: false,
    loadOlderSessions: jest.fn(),
    currentSessionId: 'sess-1',
    pendingRunApproval: null,
    resolveRunApproval: jest.fn(),
    recentCommands: [],
    historyLoading: false,
    hasMoreHistory: false,
    loadingEarlierHistory: false,
    loadEarlierMessages: jest.fn(),
    createNewSession: jest.fn(),
    deleteSessionById: jest.fn(),
    deleteLocalMessage: jest.fn(),
    disconnectGateway: jest.fn(),
    capabilitySnapshot: { status: 'fresh', groups: [], methods: {} },
    dynamicCommands: [],
    backends: [],
    selectedBackendId: undefined,
    selectBackend: jest.fn(),
    listBots: jest.fn(async () => []),
    createBot: jest.fn(),
    updateBot: jest.fn(),
    hasBotManagement: false,
    hasGroupRooms: false,
    openBot: jest.fn(async () => true),
    clearBot: jest.fn(),
    botJobs: { available: false, list: jest.fn(async () => []) },
    botGroups: { available: false, list: jest.fn(async () => []) },
    selectedBotId: undefined,
    relatedWorkflows: [],
    gatewayRequest: jest.fn(async () => ({})),
    requestedSurface: null,
    clearRequestedSurface: jest.fn(),
    requestedComposerFocus: null,
    clearRequestedComposerFocus: jest.fn(),
    requestedComposeRequest: null,
    clearRequestedComposeRequest: jest.fn(),
    ...patch,
  });
  mockSurface.messages = [];
  mockSurface.isSending = false;
  mockSurface.isCommandRunning = false;
}

let renderer: ReactTestRenderer;

async function settle(rounds = 8, ms = 1): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(ChatScreen), {
      createNodeMock: () => ({
        scrollToEnd: jest.fn(),
        scrollToIndex: jest.fn(),
        scrollToOffset: jest.fn(),
      }),
    });
  });
  await settle();
}

function find(type: ElementType): ReactTestInstance {
  const found = renderer.root.findAllByType(type);
  if (found.length === 0) throw new Error(`${String(type)} is not on screen`);
  return found[0];
}

/** Open the plain thread, which is the surface that owns the composer. */
async function openConfigurableThread(): Promise<void> {
  const roster = find(ROSTER);
  await act(async () => {
    (roster.props as { onSelectConfigurable: () => void }).onSelectConfigurable();
  });
  await settle();
}

/** Tap the composer's Call control — the offer a call button makes. */
async function pressCall(): Promise<void> {
  const onStartCall = (find(COMPOSER).props as { onStartCall?: () => void }).onStartCall;
  expect(typeof onStartCall).toBe('function');
  await act(async () => {
    onStartCall?.();
  });
  await settle();
}

/** Tap Start on the sheet the screen handed out. */
async function pressSheetStart(): Promise<void> {
  await act(async () => {
    (find(CALL_SHEET).props as { onStart: () => void }).onStart();
  });
  await settle();
}

async function pressSheetCancel(): Promise<void> {
  await act(async () => {
    (find(CALL_SHEET).props as { onCancel: () => void }).onCancel();
  });
  await settle();
}

function sheet(): { visible: boolean; engineLabel?: string } {
  return find(CALL_SHEET).props as { visible: boolean; engineLabel?: string };
}

/** What the Gate answers to `voice.capabilities`, and nothing else. */
function gateVoice(answer: unknown): void {
  mockGateway.gatewayRequest = jest.fn(async (method: string) =>
    method === 'voice.capabilities' ? answer : {},
  );
}

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.useFakeTimers();
  reset();
  mockStart.mockReset();
  mockStoredTransport = 'gate';
  mockStart.mockImplementation(async (target: MockCallTarget) => {
    startedTarget = target;
    return { result: 'started' as string };
  });
  startedTarget = undefined;
  focusEffects.length = 0;
  mockRouteParams = {};
  gateVoice(CAPABILITIES);
});

// The release offers calls only on Android.
const devicePlatform = Platform.OS;
beforeAll(() => {
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true, writable: true });
});
afterAll(() => {
  Object.defineProperty(Platform, 'OS', {
    value: devicePlatform,
    configurable: true,
    writable: true,
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
  await AsyncStorage.clear();
});

describe('a call link selects its engine for that call only (VS-078)', () => {
  test.each([
    { stored: 'local', storedTransport: 'gate', engine: 'phone', label: 'This phone only', transport: 'phone' },
    { stored: 'phone', storedTransport: 'phone', engine: 'local', label: LOCAL_LABEL, transport: 'gate' },
  ] as const)('starts $engine on $transport when the saved engine is $stored', async ({
    stored, storedTransport, engine, label, transport,
  }) => {
    await saveAppSettings({ voiceEngine: stored });
    mockStoredTransport = storedTransport;
    mockRouteParams = { call: '1', engine };

    await mount();
    await openConfigurableThread();
    expect(sheet().engineLabel).toBe(label);

    await pressSheetStart();
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(startedTarget).toMatchObject({ voiceEngine: engine, transport });
    expect((await loadAppSettings()).voiceEngine).toBe(stored);
  });

  test('engine=local opens the sheet on local while codex is stored, and the stored preference is untouched', async () => {
    await saveAppSettings({ voiceEngine: 'codex' });
    mockRouteParams = { call: '1', engine: 'local' };

    await mount();
    await openConfigurableThread();

    expect(sheet().visible).toBe(true);
    // The link's engine, not the stored one: both engines are ready, so nothing
    // fell back and the label can only name what the link asked for.
    expect(sheet().engineLabel).toBe(LOCAL_LABEL);

    await pressSheetStart();
    expect(mockStart).toHaveBeenCalledTimes(1);
    // The one call the link opened really ran on it, and the save was not
    // touched by any of it.
    expect(startedTarget?.voiceEngine).toBe('local');
    expect((await loadAppSettings()).voiceEngine).toBe('codex');

    // A later offer from the call button is the stored preference again.
    await pressCall();
    expect(sheet().visible).toBe(true);
    expect(sheet().engineLabel).toBe(CODEX_LABEL);
    await pressSheetStart();
    expect(startedTarget?.voiceEngine).toBe('codex');
    expect((await loadAppSettings()).voiceEngine).toBe('codex');
  });

  test('a call opened without a link still uses the stored preference', async () => {
    await saveAppSettings({ voiceEngine: 'codex' });

    await mount();
    await openConfigurableThread();

    await pressCall();
    expect(sheet().visible).toBe(true);
    expect(sheet().engineLabel).toBe(CODEX_LABEL);

    await pressSheetStart();
    expect(startedTarget?.voiceEngine).toBe('codex');
    expect((await loadAppSettings()).voiceEngine).toBe('codex');
  });

  test('an unresolved call uses the transport offered by the provider', async () => {
    gateVoice(null);
    await mount();
    await openConfigurableThread();

    await pressCall();
    expect(sheet().visible).toBe(true);
    expect(sheet().engineLabel).toBeUndefined();

    await pressSheetStart();
    expect(startedTarget).toMatchObject({ voiceEngine: 'auto', transport: 'gate' });
  });

  test('a dismissed link sheet leaves nothing behind for the next call', async () => {
    await saveAppSettings({ voiceEngine: 'codex' });
    mockRouteParams = { call: '1', engine: 'local' };

    await mount();
    await openConfigurableThread();
    expect(sheet().engineLabel).toBe(LOCAL_LABEL);

    await pressSheetCancel();
    expect(sheet().visible).toBe(false);

    // The override belonged to the call the link opened, so the next offer is
    // decided by the stored preference — the stored value never moved.
    await pressCall();
    expect(sheet().engineLabel).toBe(CODEX_LABEL);
    expect((await loadAppSettings()).voiceEngine).toBe('codex');
  });
});
