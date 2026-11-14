/**
 * VS-101 — Retry after a failed turn re-runs the SAME question in place.
 *
 * The duplicate bubble is raised by the provider, not by this screen: a send
 * that names no message adds one, a send that names the id already in the
 * thread updates that bubble. The screen is the one place that knows which
 * question is being retried, so what is proved here is the id hand-over at the
 * `sendChatInput` seam — the provider's own send already honours `messageId`
 * (its outbox flush and confirmation resend have always used it).
 *
 * The stand-in provider below therefore applies exactly that rule, with the
 * shipped `addUserMessage` reducer for the append path, and the assertions are
 * on what the operator would see: one bubble for the question, carrying the id
 * that was already on screen, with the same skills and attachments the first
 * send carried.
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
/** Focus effects the screen registered; registered so the mock has somewhere to put them. */
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
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true })),
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true, assets: null })),
  launchCameraAsync: jest.fn(async () => ({ canceled: true, assets: null })),
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
jest.mock('@/components/chat/thread-config-sheet', () => ({ ThreadConfigSheet: 'ThreadConfigSheet' }));
jest.mock('@/components/chat/new-agent-sheet', () => ({ NewAgentSheet: 'NewAgentSheet' }));
jest.mock('@/components/chat/approval-sheet', () => ({ ApprovalSheet: 'ApprovalSheet' }));
jest.mock('@/components/chat/bot-detail-sheet', () => ({ BotDetailSheet: 'BotDetailSheet' }));
jest.mock('@/components/chat/create-group-sheet', () => ({ CreateGroupSheet: 'CreateGroupSheet' }));
jest.mock('@/components/chat/group-room-action-sheet', () => ({ GroupRoomActionSheet: 'GroupRoomActionSheet' }));
jest.mock('@/components/chat/message-actions-sheet', () => ({ MessageActionsSheet: 'MessageActionsSheet' }));
jest.mock('@/components/chat/pairing-sheet', () => ({ PairingSheet: 'PairingSheet' }));
jest.mock('@/components/chat/confirmation-sheet', () => ({ ConfirmationSheet: 'ConfirmationSheet' }));
jest.mock('@/components/chat/slash-command-palette', () => ({ SlashCommandPalette: 'SlashCommandPalette' }));
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
const mockSurface: {
  messages: ChatMessage[];
  isSending: boolean;
  isCommandRunning: boolean;
} = { messages: [], isSending: false, isCommandRunning: false };

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

import { ChatScreen } from '@/components/chat/chat-screen';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { addUserMessage } from '@/lib/gateway/message-reducer';
import type { ChatMessage } from '@/lib/gateway/types';

const COMPOSER = 'ChatComposer' as ElementType;
const ROSTER = 'ChatRoster' as ElementType;
const BUBBLE = 'MessageBubble' as ElementType;

const GATEWAY = { id: 'gw-1', name: 'Home PC', url: 'http://gate.test', kind: 'hermes', model: 'vision-1' };

const FAILED_TURN = {
  id: 'a1',
  role: 'assistant',
  text: 'Error: the host closed the turn',
  timestamp: 2,
} as unknown as ChatMessage;

type SendOptions = {
  messageId?: string;
  skills?: unknown[];
  attachments?: ChatMessage['attachments'];
};

/** Every send the screen made, in order, with the options it handed over. */
const sends: { text: string; options?: SendOptions }[] = [];

/**
 * The provider's send, at the same seam and with the same id rule: a send that
 * names a message already in the thread updates that bubble (its `queued` flag
 * clear, its text and attachments untouched); one that names nothing appends a
 * new user bubble through the shipped reducer.
 */
function sendThroughProvider(text: string, options?: SendOptions): Promise<'sent'> {
  sends.push({ text, options });
  if (options?.messageId) {
    const id = options.messageId;
    mockSurface.messages = mockSurface.messages.map((message) =>
      message.id === id ? { ...message, queued: false } : message,
    );
  } else {
    mockSurface.messages = addUserMessage(
      mockSurface.messages,
      text.trim(),
      undefined,
      options?.attachments,
    );
  }
  return Promise.resolve('sent' as const);
}

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
    sendChatInput: jest.fn(sendThroughProvider),
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
    // The attach control is offered on the strength of this catalogue entry.
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

let renderer: ReactTestRenderer;

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

/** Re-render from the provider's own state, as a provider update would. */
async function providerRender(): Promise<void> {
  await act(async () => {
    renderer.update(createElement(ChatScreen));
  });
  await settle();
}

async function typeInto(text: string): Promise<void> {
  await act(async () => {
    (find(COMPOSER).props as { onChangeText: (next: string) => void }).onChangeText(text);
  });
  await settle();
}

async function pressSend(): Promise<void> {
  await act(async () => {
    void (find(COMPOSER).props as { onSend: () => Promise<void> }).onSend();
  });
  await settle();
}

/** Stage a photo the way the picker hands one over. */
async function attach(): Promise<void> {
  (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({
    canceled: false,
    assets: [
      {
        uri: 'file:///tmp/0.jpg',
        mimeType: 'image/jpeg',
        base64: 'A'.repeat(200),
        fileName: '0.jpg',
      },
    ],
  });
  await act(async () => {
    await (find(COMPOSER).props as { onAttach?: () => Promise<void> }).onAttach?.();
  });
  await settle();
}

/** The user turns the operator can see in the transcript. */
function userBubbles(): ChatMessage[] {
  return renderer.root
    .findAllByType(BUBBLE)
    .map((bubble) => bubble.props.message as ChatMessage)
    .filter((message) => message.role === 'user');
}

/** The failed turn's bubble offers Retry; tap it. */
async function retryFailedTurn(): Promise<void> {
  const failed = renderer.root
    .findAllByType(BUBBLE)
    .find((bubble) => (bubble.props.message as ChatMessage).id === FAILED_TURN.id);
  const onResume = failed?.props.onResume as ((message: ChatMessage) => void) | undefined;
  expect(onResume).toBeInstanceOf(Function);
  await act(async () => {
    onResume?.(FAILED_TURN);
  });
  await settle();
}

/** The provider reports the turn failed: its error bubble lands in the thread. */
async function failTheTurn(): Promise<void> {
  mockSurface.messages = [...mockSurface.messages, FAILED_TURN];
  await providerRender();
}

beforeEach(() => {
  jest.useFakeTimers();
  reset();
  sends.length = 0;
  jest.clearAllMocks();
  focusEffects.length = 0;
  mockDeviceSpeech.voices = [{ identifier: 'en-GB-Samantha' }];
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

test('after a failed turn, Retry leaves exactly one bubble holding the question', async () => {
  await mount();
  await openConfigurableThread();
  await typeInto('ping');
  await pressSend();
  await providerRender();

  expect(userBubbles().map((message) => message.text)).toEqual(['ping']);
  const asked = userBubbles()[0];

  await failTheTurn();
  await retryFailedTurn();
  await providerRender();

  // One question, the one that was already on screen: the retry updated it
  // rather than appending a second copy of the operator's words.
  expect(userBubbles().map((message) => message.text)).toEqual(['ping']);
  expect(userBubbles()[0].id).toBe(asked.id);

  // Which is the id the screen handed back for the retry.
  expect(sends).toHaveLength(2);
  expect(sends[1].text).toBe('ping');
  expect(sends[1].options?.messageId).toBe(asked.id);
});

test("the retry carries the retried line's id with the first send's skills and attachments", async () => {
  await mount();
  await openConfigurableThread();
  await attach();
  await typeInto('describe this');
  await pressSend();
  await providerRender();

  const first = sends[0];
  // The first send is a new line: no id, so it appends the question.
  expect(first.text).toBe('describe this');
  expect(first.options?.messageId).toBeUndefined();
  expect(first.options?.attachments).toHaveLength(1);
  const asked = userBubbles()[0];

  await failTheTurn();
  await retryFailedTurn();
  await providerRender();

  const retry = sends[1];
  expect(retry.text).toBe('describe this');
  expect(retry.options?.messageId).toBe(asked.id);
  // The same line's stored work travels with it: the very attachments the
  // bubble already holds (not a copy), and the same skills the first send
  // carried.
  expect(retry.options?.attachments).toBe(asked.attachments);
  expect(retry.options?.attachments).toEqual(first.options?.attachments);
  expect(retry.options?.skills).toEqual(first.options?.skills);

  // And still one bubble, not two.
  expect(userBubbles().filter((message) => message.text === 'describe this')).toHaveLength(1);
});
