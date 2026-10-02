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
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useFocusEffect: (effect: () => unknown) => {
    focusEffects.push(effect);
  },
  useIsFocused: () => true,
  useLocalSearchParams: () => ({}),
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
import * as Clipboard from 'expo-clipboard';
import { haptics } from '@/lib/haptics';
import { MAX_CHAT_ATTACHMENT_CHARS } from '@/lib/gateway/chat-parts';
import { VOICE_PREFERENCES_STORAGE_KEY } from '@/lib/voice/voice-preferences';
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

describe('ATTACH-2 — the phone holds a bounded turn of photos', () => {
  test('the picker is asked to compress: quality 1 hands back the camera bytes', async () => {
    await mount();
    await openConfigurableThread();

    await attach();

    const options = (ImagePicker.launchImageLibraryAsync as jest.Mock).mock.calls[0][0];
    // `quality: 1` is expo-image-picker's "compress for maximum quality", and the
    // base64 the picker returns is then megabytes per photo.
    expect(options.quality).not.toBe(1);
    expect(options.quality).toBeLessThan(1);
  });

  test('a photo too big for the turn is refused out loud, not staged silently', async () => {
    await mount();
    await openConfigurableThread();
    pickerReturns([photo(1024, 1), photo(MAX_CHAT_ATTACHMENT_CHARS, 2)]);

    await attach();

    // The one that fits is staged; the one that would blow the turn's budget is
    // not held at all, and the composer says so.
    expect(staged()).toHaveLength(1);
    expect(shown().join(' ')).toContain('too large to add');
  });
});

describe('ATTACH-3 — staged photos belong to one thread', () => {
  test('photos composed in one thread are not sent into the next one', async () => {
    await mount();
    await openConfigurableThread();
    pickerReturns([photo(2048, 1)]);
    await attach();
    expect(staged()).toHaveLength(1);

    // The roster row opens another Bot's Chat — a different thread, on the same
    // gateway, where the drafts store keeps its own text.
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

    expect(staged()).toHaveLength(0);

    await type('what is this?');
    await pressSend();

    // The turn that leaves for Ada's thread carries no images at all.
    expect(sentAttachments()).toEqual([]);
  });

  test('photos survive a thread that did not change, so a two-step pick still sends', async () => {
    await mount();
    await openConfigurableThread();
    pickerReturns([photo(2048, 1)]);
    await attach();
    pickerReturns([photo(2048, 2)]);
    await attach();

    expect(staged()).toHaveLength(2);

    await type('both of these');
    await pressSend();
    expect(sentAttachments()).toHaveLength(2);
  });
});

describe('ATTACH-4 — a send that could not travel does not take the photos with it', () => {
  test('photos come back on the composer when the turn was not delivered', async () => {
    await mount();
    await openConfigurableThread();
    pickerReturns([photo(2048, 1)]);
    await attach();
    await type('what is this?');
    // Disconnected, the provider parks the words and refuses the pictures (an
    // outbox row carries text only) — it answers 'offline'.
    sendInput().mockResolvedValue('offline');

    await pressSend();

    expect(staged()).toHaveLength(1);
    expect(shown().join(' ')).toContain('did not send');
    // The words went nowhere either, so they come back rather than being eaten
    // by a send the composer was told nothing about.
    expect((find(COMPOSER).props as { draft: string }).draft).toBe('what is this?');
  });

  test('a turn the Gate took clears the composer and says nothing', async () => {
    await mount();
    await openConfigurableThread();
    pickerReturns([photo(2048, 1)]);
    await attach();
    await type('what is this?');
    sendInput().mockResolvedValue('sent');

    await pressSend();

    expect(staged()).toHaveLength(0);
    expect(shown().join(' ')).not.toContain('did not send');
  });
});

describe('VOICE-1 — the one voice blob is written through one queue', () => {
  async function storedVoiceBlob(): Promise<Record<string, unknown>> {
    const raw = await AsyncStorage.getItem(VOICE_PREFERENCES_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }

  test('the speaker toggle and a Bot voice tapped together both survive', async () => {
    await mount();
    await openConfigurableThread();
    // The Bot whose Chat is open is what keys the voice.
    (mockGateway.listBots as jest.Mock).mockResolvedValue([{ id: 'bot-9', displayName: 'Ada' }]);
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

    // The header only offers the speaker where this device has a voice to speak
    // with, which is read on the focus edge.
    await runFocusEffects();

    // Two taps inside one storage round trip: the toggle on the overflow sheet
    // and the voice chip on the Bot's chrome.
    await act(async () => {
      (find(OVERFLOW).props as { onSpeakerPress: () => void }).onSpeakerPress();
      (find(BOT_CHROME).props as { onVoiceSelect: (id: string) => void }).onVoiceSelect('en-GB-Daniel');
    });
    await settle();

    const stored = await storedVoiceBlob();
    const keys = Object.keys(stored);
    expect(keys.some((key) => key.startsWith('speaker:'))).toBe(true);
    expect(stored['voice:gw-1:bot-9']).toMatchObject({ voiceIdentifier: 'en-GB-Daniel' });
  });
});

describe('RESUME-1 — Send again / Retry is not offered while a turn is live', () => {
  const failedTurn = {
    id: 'a1',
    role: 'assistant',
    text: 'Error: the host closed the turn',
    timestamp: 2,
  } as unknown as ChatMessage;

  test('an old error bubble offers no retry while another turn is streaming', async () => {
    mockSurface.messages = [userMessage('ping'), failedTurn];
    mockSurface.isSending = true;
    await mount();
    await openConfigurableThread();

    const bubbles = renderer.root.findAllByType(BUBBLE);
    expect(bubbles).toHaveLength(2);
    // A retry is a send, and a send that arrives while a turn is live is dropped
    // by the provider — so the chip used to render, swallow the tap and report
    // nothing at all.
    for (const bubble of bubbles) {
      expect(bubble.props.onResume).toBeUndefined();
    }
  });

  test('it is back the moment the thread is idle, so a retry is still one tap', async () => {
    mockSurface.messages = [userMessage('ping'), failedTurn];
    mockSurface.isSending = false;
    await mount();
    await openConfigurableThread();

    const error = renderer.root.findAllByType(BUBBLE)[1];
    expect(error.props.onResume).toBeInstanceOf(Function);
    await act(async () => {
      error.props.onResume(failedTurn);
    });
    await settle();
    expect(sendInput()).toHaveBeenCalledWith('ping', expect.objectContaining({ skills: [] }));
  });
});

describe('PERF-1 — the render body walks the transcript once', () => {
  test('a re-render no longer scans the message window twice', async () => {
    // A window at the cap `messages.ts` holds. Every read of an index is
    // counted, so a scan of the window shows up as reads whatever walks it.
    const window_ = Array.from({ length: 200 }, (_, index) => ({
      id: `m${index}`,
      role: 'user',
      text: `line ${index}`,
      timestamp: index,
    }));
    let reads = 0;
    mockSurface.messages = new Proxy(window_, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) reads += 1;
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as ChatMessage[];
    await mount();
    await openConfigurableThread();

    // A re-render for any reason other than the transcript itself (a keystroke):
    // the memos keyed on the array do not re-run, so what is measured is the
    // render body.
    reads = 0;
    await type('a keystroke');

    // Before: `messages.some(...)` AND `messages.filter(...).length` — two walks
    // of the window plus an allocated array, on every coalesced delta batch.
    expect(reads).toBeLessThanOrEqual(window_.length);
  });
});

describe('SCROLL-1 — a growing transcript does not restart an animation per delta', () => {
  test('a content-size change mid-stream jumps instead of animating', async () => {
    mockSurface.messages = [
      userMessage('ping'),
      { id: 'a1', role: 'assistant', text: 'working', streaming: true, timestamp: 2 } as ChatMessage,
    ];
    await mount();
    await openConfigurableThread();

    const { scrollToEnd } = listRefMock();
    // Three coalesced delta batches, as a streaming turn produces.
    for (let batch = 0; batch < 3; batch += 1) {
      await act(async () => {
        find(FlatList).props.onContentSizeChange();
      });
    }

    expect(scrollToEnd).toHaveBeenCalledTimes(3);
    for (const call of scrollToEnd.mock.calls) {
      expect(call[0]).toEqual({ animated: false });
    }
  });

  test('with nothing streaming, the same change still glides', async () => {
    mockSurface.messages = [userMessage('ping')];
    await mount();
    await openConfigurableThread();

    const { scrollToEnd } = listRefMock();
    await act(async () => {
      find(FlatList).props.onContentSizeChange();
    });

    expect(scrollToEnd).toHaveBeenCalledWith({ animated: true });
  });
});

describe('CALL-1 — two opens of the call sheet cannot race', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  }

  const CAPABILITIES = { engines: [{ id: 'codex', ready: true }] };

  test('the slower first read cannot clear the second open\'s guard', async () => {
    const first = deferred<typeof CAPABILITIES>();
    const second = deferred<typeof CAPABILITIES>();
    let reads = 0;
    (mockGateway.gatewayRequest as jest.Mock).mockImplementation(async (method: string) => {
      if (method !== 'voice.capabilities') return {};
      reads += 1;
      return reads === 1 ? first.promise : second.promise;
    });
    await mount();
    await openConfigurableThread();

    await pressStartCall();
    await pressCancelCall();
    await pressStartCall();

    // The first request finally answers, after the sheet was dismissed and
    // reopened behind it.
    await act(async () => {
      first.resolve(CAPABILITIES);
      await first.promise;
    });
    await settle();

    // The sheet this open is still waiting on its own read: busy, and Start held
    // — instead of a Start that would pick the phone recogniser with nothing
    // saying so.
    const sheet = find(CALL_SHEET).props as { busy: boolean; startDisabled: boolean };
    expect(sheet.busy).toBe(true);
    expect(sheet.startDisabled).toBe(true);
  });

  test('the read the open is waiting on does settle the sheet', async () => {
    const CAPS = { engines: [{ id: 'codex', ready: true }] };
    (mockGateway.gatewayRequest as jest.Mock).mockImplementation(async (method: string) =>
      method === 'voice.capabilities' ? CAPS : {},
    );
    await mount();
    await openConfigurableThread();

    await pressStartCall();
    await settle();

    const sheet = find(CALL_SHEET).props as { busy: boolean; startDisabled: boolean };
    expect(sheet.busy).toBe(false);
    expect(sheet.startDisabled).toBe(false);
  });
});

describe('CLIP-1 — a refused clipboard write is not a silent no-op', () => {
  test('the banner says the copy failed, and no haptic claims it worked', async () => {
    reset({ lastError: new Error('the host refused to answer the turn') });
    (Clipboard.setStringAsync as jest.Mock).mockRejectedValue(new Error('Clipboard is unavailable'));
    await mount();

    const card = find(ERROR_CARD).props as { retryLabel?: string; onRetry?: () => void };
    expect(card.retryLabel).toBe('Copy details');
    await act(async () => {
      card.onRetry?.();
    });
    await settle();

    expect(shown().join(' ')).toContain('could not be copied');
    expect(haptics.success).not.toHaveBeenCalled();

    // A later tap that really does copy takes the notice back down, rather than
    // leaving a refusal under a banner the operator has since dealt with.
    (Clipboard.setStringAsync as jest.Mock).mockResolvedValue(true);
    await act(async () => {
      find(ERROR_CARD).props.onRetry?.();
    });
    await settle();

    expect(shown().join(' ')).not.toContain('could not be copied');
    expect(haptics.success).toHaveBeenCalledTimes(1);
  });

  test('a clipboard that took the text still haptics and says nothing', async () => {
    reset({ lastError: new Error('the host refused to answer the turn') });
    await mount();

    const card = find(ERROR_CARD).props as { onRetry?: () => void };
    await act(async () => {
      card.onRetry?.();
    });
    await settle();

    expect(haptics.success).toHaveBeenCalledTimes(1);
    expect(shown().join(' ')).not.toContain('could not be copied');
  });
});