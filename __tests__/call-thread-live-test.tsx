import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState } from 'react-native';

import {
  HandsfreeVoiceProvider,
  useHandsfreeVoice,
  type HandsfreeCallTarget,
  type HandsfreeVoiceContextValue,
} from '@/context/handsfree-voice-provider';
import { callProjectionForThread } from '@/lib/voice/call-thread-projection';

const mockSharedValue = { value: 0 };
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
  useSharedValue: () => mockSharedValue,
}));

const mockGateway = {
  activeGateway: { id: 'gateway-a', url: 'http://127.0.0.1:8760', token: 'token' },
  status: 'connected' as const,
  currentSessionId: 'session-a',
  selectedBotId: 'bot-a',
  pendingRunApproval: null,
  settings: { voiceEngine: 'local' },
  sendChatInput: jest.fn(async () => 'sent' as const),
  gatewayRequest: jest.fn(async (method: string) => method === 'voice.session.start'
    ? { voiceSessionId: 'call-a', streamPath: '/v1/voice/stream', engine: 'local' }
    : { stopped: true }),
  reloadHistory: jest.fn(async () => undefined),
};
const mockMessages: { messages: unknown[] } = { messages: [] };
jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => mockGateway,
  useChatSurface: () => ({ ...mockMessages, isSending: false, isCommandRunning: false }),
}));
jest.mock('@/lib/notifications/push-registration', () => ({
  pushDeviceParams: jest.fn(async () => ({ deviceId: 'phone-12345678' })),
}));
jest.mock('@/lib/voice/speech', () => ({
  beginHandsfreeCall: jest.fn(), endHandsfreeCall: jest.fn(), stopSpeech: jest.fn(async () => undefined),
}));

type Listener = (event: unknown) => void;
const listeners = new Map<string, Listener[]>();
const mockNative = {
  getAvailability: jest.fn(async () => ({ recognition: false, synthesis: false, maxSpeechInputLength: 0 })),
  startSession: jest.fn(async () => 'started' as const),
  stopSession: jest.fn(async () => undefined),
  startListening: jest.fn(async () => true),
  stopListening: jest.fn(async () => undefined),
  speak: jest.fn(async () => true),
  stopSpeaking: jest.fn(async () => undefined),
  setMuted: jest.fn(async () => undefined),
  playSendEarcon: jest.fn(async () => undefined),
  startGateMedia: jest.fn(async () => true),
  sendGateControl: jest.fn(async () => true),
  stopGateMedia: jest.fn(async () => undefined),
  verifyLaunch: jest.fn(async () => true),
  addListener: jest.fn((name: string, listener: Listener) => {
    listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    return { remove: () => undefined };
  }),
};
jest.mock('@/lib/voice/handsfree-device', () => ({ loadHandsfreeModule: jest.fn(async () => mockNative) }));

const target: HandsfreeCallTarget = {
  gatewayId: 'gateway-a', sessionId: 'session-a', surfaceKind: 'bot', botId: 'bot-a',
  label: 'Bot', voice: {}, transport: 'gate', voiceEngine: 'local',
};
let renderer: ReactTestRenderer | null = null;
let latest: HandsfreeVoiceContextValue | undefined;
function Probe() {
  latest = useHandsfreeVoice();
  return null;
}
function emit(frame: object) {
  const json = JSON.stringify(frame);
  for (const listener of listeners.get('gate') ?? []) listener({ frame: json });
}
async function actAsync(body: () => Promise<void> | void) {
  await act(async () => { await body(); });
}
async function settle() {
  for (let i = 0; i < 8; i += 1) await jest.advanceTimersByTimeAsync(0);
}

beforeEach(async () => {
  jest.useFakeTimers();
  listeners.clear();
  latest = undefined;
  mockMessages.messages = [];
  mockGateway.currentSessionId = 'session-a';
  AppState.currentState = 'active';
  await actAsync(async () => {
    renderer = create(createElement(HandsfreeVoiceProvider, null, createElement(Probe) as ReactNode));
  });
  await actAsync(async () => { await Promise.resolve(); await Promise.resolve(); });
});

afterEach(async () => {
  const mounted = renderer;
  renderer = null;
  if (mounted) await actAsync(async () => mounted.unmount());
  jest.useRealTimers();
});

describe('live call thread projection', () => {
  test('renders each commit and first reply immediately, then deduplicates a replay', async () => {
    await actAsync(async () => {
      const starting = latest!.start(target);
      await settle();
      emit({ v: 2, callId: 'call-a', seq: 1, ts: 0, t: 'ready', engine: 'local' });
      emit({ v: 2, callId: 'call-a', seq: 2, ts: 1, t: 'phase', phase: 'listening' });
      expect((await starting).result).toBe('started');
    });
    const frameAt = Date.now();
    await actAsync(async () => {
      emit({ v: 2, callId: 'call-a', seq: 3, ts: 2, t: 'final', turnId: 'turn-a', text: 'Book a table' });
      emit({ v: 2, callId: 'call-a', seq: 4, ts: 3, t: 'reply', turnId: 'turn-a', offset: 0, delta: 'Done' });
      emit({ v: 2, callId: 'call-a', seq: 4, ts: 3, t: 'reply', turnId: 'turn-a', offset: 0, delta: 'Done' });
    });

    const projection = latest!.callThreadProjection;
    expect(Date.now() - frameAt).toBeLessThanOrEqual(300);
    expect(projection?.messages.map((message) => message.text)).toEqual(['Book a table', 'Done']);
    expect(projection?.messages[1].streaming).toBe(true);
    expect(callProjectionForThread(projection, 'gateway-a:bot:bot-a:session-a', [])).toHaveLength(2);
  });

  test('keeps an in-flight call projection out of a different selected thread', async () => {
    await actAsync(async () => {
      const starting = latest!.start(target);
      await settle();
      emit({ v: 2, callId: 'call-a', seq: 1, ts: 0, t: 'ready', engine: 'local' });
      emit({ v: 2, callId: 'call-a', seq: 2, ts: 1, t: 'phase', phase: 'listening' });
      expect((await starting).result).toBe('started');
    });
    await actAsync(async () => {
      emit({ v: 2, callId: 'call-a', seq: 3, ts: 2, t: 'final', turnId: 'turn-a', text: 'Private thread words' });
    });
    const captured = latest!.callThreadProjection;
    expect(callProjectionForThread(captured, 'gateway-a:bot:bot-a:session-a', [])).toHaveLength(1);

    mockGateway.currentSessionId = 'session-b';
    await actAsync(async () => {
      renderer!.update(createElement(HandsfreeVoiceProvider, null, createElement(Probe) as ReactNode));
    });
    expect(latest!.callThreadProjection?.messages[0].text).toBe('Private thread words');
    expect(callProjectionForThread(latest!.callThreadProjection, 'gateway-a:bot:bot-a:session-b', [])).toEqual([]);
  });
});
