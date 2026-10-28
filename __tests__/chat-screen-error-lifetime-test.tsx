/**
 * R4S-chat1a — the chat screen's own defects, rendered.
 *
 * Every case here is a behaviour of the mounted screen: what the composer is
 * handed, what a send is handed, what the transcript is asked to do, and what
 * the call sheet is told while a read is in flight. Nothing reaches the
 * network: the provider is the seam, exactly as it is on the device, and the
 * parts of the tree that are not under test stand in as host components whose
 * props are the screen's real output.
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
/** Focus effects the screen registered, so a test can run the focus reads. */
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
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true })),
  launchCameraAsync: jest.fn(async () => ({ canceled: true, assets: null })),
}));
// The document path: the picker hands back a cache copy and the screen reads it.
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(async () => ({ canceled: true, assets: null })),
}));
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 8 })),
  readAsStringAsync: jest.fn(async () => 'AAAA'),
  EncodingType: { Base64: 'base64' },
}));
jest.mock('@/lib/haptics', () => ({
  haptics: { light: jest.fn(async () => undefined), success: jest.fn(async () => undefined) },
}));

// The kit primitives: host components that keep their props verbatim, so a test
// can read what the screen handed them.
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

// The screen's own children: stand-ins whose props ARE the screen's output.
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
jest.mock('@/components/chat/thread-config-sheet', () => ({
  ThreadConfigSheet: 'ThreadConfigSheet',
}));
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

jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => mockGateway,
  useChatSurface: () => mockSurface,
}));
jest.mock('@/context/handsfree-voice-provider', () => ({
  useHandsfreeVoice: () => ({
    active: false,
    canStart: true,
    start: jest.fn(),
    end: jest.fn(),
    startBlocker: undefined,
    callsEnded: 0,
    lastEndReason: undefined,
  }),
}));

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { FlatList } from 'react-native';

import { ChatScreen } from '@/components/chat/chat-screen';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Clipboard from 'expo-clipboard';
import { haptics } from '@/lib/haptics';
import { MAX_CHAT_ATTACHMENT_CHARS } from '@/lib/gateway/chat-parts';
import { VOICE_PREFERENCES_STORAGE_KEY } from '@/lib/voice/voice-preferences';
import { saveAppSettings } from '@/lib/settings/app-settings';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChatMessage } from '@/lib/gateway/types';

const COMPOSER = 'ChatComposer' as ElementType;
const ROSTER = 'ChatRoster' as ElementType;
const HEADER = 'ChatHeader' as ElementType;
const BUBBLE = 'MessageBubble' as ElementType;
const OVERFLOW = 'ChatOverflowSheet' as ElementType;
const BOT_CHROME = 'BotChrome' as ElementType;
const CALL_SHEET = 'HandsfreeCallSheet' as ElementType;
const ERROR_CARD = 'ErrorCard' as ElementType;

const GATEWAY = { id: 'gw-1', name: 'Home PC', url: 'http://gate.test', kind: 'hermes', model: 'vision-1' };

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
    // A gateway whose send model DECLARES image input: the attach control is
    // offered on the strength of this catalogue entry, so the photo cases below
    // are the ones an operator with a vision model is in.
    modelCatalog: [{ id: 'vision-1', capabilities: ['image'] }] as unknown[],
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

function userMessage(text: string): ChatMessage {
  return { id: `m-${text}`, role: 'user', text, timestamp: 1 } as ChatMessage;
}

let renderer: ReactTestRenderer;
/** Every host/composite ref the tree was given, in the order React created them. */
const refMocks: Record<string, unknown>[] = [];

/** The object behind the transcript list's own ref. */
function listRefMock(): { scrollToEnd: jest.Mock } {
  // The list the screen holds by ref is this instance, so the scroll command it
  // issues is this method: recorded here rather than on the prototype.
  const list = find(FlatList).instance as unknown as { scrollToEnd?: unknown } | null;
  if (!list) throw new Error('the transcript list has no ref');
  const recorder = jest.fn();
  list.scrollToEnd = recorder;
  return { scrollToEnd: recorder };
}

async function settle(rounds = 6, ms = 1): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(ChatScreen), {
      // react-test-renderer leaves every ref null unless the tree is told what a
      // host object is; the transcript list keeps its scrolling methods on its ref.
      createNodeMock: () => {
        const mock = { scrollToEnd: jest.fn(), scrollToIndex: jest.fn(), scrollToOffset: jest.fn() };
        refMocks.push(mock);
        return mock;
      },
    });
  });
  await settle();
}

/** Open the plain thread, which is the surface that owns the composer. */
async function openConfigurableThread(): Promise<void> {
  const roster = find(ROSTER);
  await act(async () => {
    (roster.props as { onSelectConfigurable: () => void }).onSelectConfigurable();
  });
  await settle();
}

/** Leave the open thread for a Bot Chat — a different composer on the same screen. */
async function switchToBotThread(): Promise<void> {
  await act(async () => {
    (find(HEADER).props as { onRosterPress: () => void }).onRosterPress();
  });
  await settle();
  await act(async () => {
    (find(ROSTER).props as { onSelectBot: (bot: unknown) => void }).onSelectBot({
      id: 'bot-9',
      displayName: 'Ada',
    });
  });
  await settle();
}

/** A promise the test resolves itself, so an OS round trip can be held open. */
function deferredValue<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function find(type: ElementType): ReactTestInstance {
  const found = renderer.root.findAllByType(type);
  if (found.length === 0) throw new Error(`${String(type)} is not on screen`);
  return found[0];
}

/** The composer's staged attachments, as the screen handed them over. */
function staged(): { kind: string; uri: string }[] {
  return (find(COMPOSER).props.attachments ?? []) as { kind: string; uri: string }[];
}

/** Every string rendered under the mocked Text primitive, in order. */
function shown(): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  for (const text of renderer.root.findAllByType('Text' as ElementType)) walk(text.props.children);
  return out;
}

beforeEach(() => {
  jest.useFakeTimers();
  reset();
  jest.clearAllMocks();
  refMocks.length = 0;
  focusEffects.length = 0;
  mockRouteParams = {};
  mockDeviceSpeech.voices = [{ identifier: 'en-GB-Samantha' }];
  (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({ canceled: true, assets: null });
  (Clipboard.setStringAsync as jest.Mock).mockResolvedValue(true);
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

test('the screen mounts a thread composer', async () => {
  await mount();
  await openConfigurableThread();
  expect(renderer.root.findAllByType(COMPOSER).length).toBeGreaterThan(0);
});

/** The picker answered with these photos. */
function pickerReturns(assets: unknown[]): void {
  (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({ canceled: false, assets });
}

/** A picker asset of `chars` base64 characters, which is what the phone holds. */
function photo(chars: number, index: number) {
  return {
    uri: `file:///tmp/${index}.jpg`,
    mimeType: 'image/jpeg',
    base64: String.fromCharCode(65 + index).repeat(chars),
    fileName: `${index}.jpg`,
  };
}

/** Tap the paperclip, which is only offered where the model takes images. */
async function attach(): Promise<void> {
  const composer = find(COMPOSER);
  const onAttach = (composer.props as { onAttach?: () => Promise<void> }).onAttach;
  expect(typeof onAttach).toBe('function');
  await act(async () => {
    await onAttach?.();
  });
  await settle();
}

async function type(text: string): Promise<void> {
  const composer = find(COMPOSER);
  await act(async () => {
    (composer.props as { onChangeText: (next: string) => void }).onChangeText(text);
  });
  await settle();
}

async function pressSend(): Promise<void> {
  const composer = find(COMPOSER);
  await act(async () => {
    void (composer.props as { onSend: () => Promise<void> }).onSend();
  });
  await settle();
}

/** Run the reads the screen defers to a focus edge (this device's voices). */
async function runFocusEffects(): Promise<void> {
  await act(async () => {
    for (const effect of focusEffects.splice(0)) effect();
  });
  await settle();
}

/** Open the hands-free confirm sheet (the composer's own call control). */
async function pressStartCall(): Promise<void> {
  const onStartCall = (find(COMPOSER).props as { onStartCall?: () => void }).onStartCall;
  expect(typeof onStartCall).toBe('function');
  await act(async () => {
    onStartCall?.();
  });
  await settle();
}

async function pressCancelCall(): Promise<void> {
  await act(async () => {
    (find(CALL_SHEET).props as { onCancel: () => void }).onCancel();
  });
  await settle();
}

function sendInput(): jest.Mock {
  return mockGateway.sendChatInput as jest.Mock;
}

/** What the send was actually handed, images and all. */
function sentAttachments(): unknown {
  const calls = sendInput().mock.calls;
  const last = calls[calls.length - 1];
  return (last?.[1] as { attachments?: unknown[] } | undefined)?.attachments;
}


describe('ERROR-2 — a replacement error gets its own 12 seconds', () => {
  /** A dismissible error: the humanizer reads it as an entry mistake. */
  const FIRST = 'Invalid gateway URL: alpha';
  const SECOND = 'Invalid gateway URL: beta';

  test('the timer restarts for the error that replaced the one on screen', async () => {
    const dismiss = jest.fn(() => {
      mockGateway.lastError = null;
    });
    reset({ lastError: FIRST, clearLastError: dismiss });
    await mount();
    expect(renderer.root.findAllByType(ERROR_CARD)).toHaveLength(1);

    // Eleven seconds into the first error's life: up, and nothing dismissed it.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(11_000);
    });
    expect(dismiss).not.toHaveBeenCalled();

    // A second dismissible error replaces it at the same banner position, with
    // the same stable `onDismiss` (the provider writes `lastError` directly).
    mockGateway.lastError = SECOND;
    await act(async () => {
      renderer.update(createElement(ChatScreen));
    });
    await settle();
    // The banner on screen is now the SECOND error's, not the first one's.
    expect((find(ERROR_CARD).props as { cause?: string }).cause).toContain('beta');

    // 1.5 s later the FIRST error's deadline has passed. The replacement owes a
    // full lifetime of its own, so it is still up.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_500);
    });
    expect(dismiss).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType(ERROR_CARD)).toHaveLength(1);

    // ...and it comes down on its own deadline, not before it.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_600);
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  test('an actionable error still arms no timer', async () => {
    const dismiss = jest.fn();
    reset({ lastError: 'network unreachable', clearLastError: dismiss });
    await mount();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });

    // Reconnect-class errors carry the control that fixes the fault; timing
    // that away mid-read would take the fix off screen.
    expect(dismiss).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType(ERROR_CARD)).toHaveLength(1);
    expect((find(ERROR_CARD).props as { retryLabel?: string }).retryLabel).toBe('Reconnect gateway');
  });
});
