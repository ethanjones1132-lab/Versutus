// ─── VS-012: a hands-free start must really open a call ─────────────────────
// The provider used to report every failed `voice.session.start` as one
// `unavailable`, and the tests around it asserted that some error copy did or
// did not appear. That can pass while no call exists at all — which is exactly
// what shipped. This drives `useHandsfreeVoice().start` against a fake Gate that
// keeps the sessions it opens, and reads the opened call back: the id it was
// given, the engine and Bot thread it was opened for, the device it was opened
// by, and the audio link that was joined with that id. A refusal must open
// nothing, return to idle, and leave the same provider able to take the retry.
//
// The fake Gate is the only seam: no socket, no microphone, no network. The
// native module (handsfree-device) is the same fake the provider's other tests
// use, and the frames it delivers are the Gate's own protocol.

import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState } from 'react-native';

import {
  HandsfreeVoiceProvider,
  useHandsfreeVoice,
  type HandsfreeCallTarget,
  type HandsfreeVoiceContextValue,
} from '@/context/handsfree-voice-provider';

jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
  useSharedValue: (value: number) => ({ value }),
}));

const mockBacking = new Map<string, string>();
jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: jest.fn(async (key: string) => mockBacking.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      mockBacking.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      mockBacking.delete(key);
    }),
  },
}));

// ─── The fake Gate ──────────────────────────────────────────────────────────

type FakeSession = {
  voiceSessionId: string;
  engine: string;
  thread: { kind: string; sessionId: string; botId?: string };
  deviceId: string;
};

const mockGate = {
  /** Sessions this fake Gate opened, by the id it gave them. */
  sessions: new Map<string, FakeSession>(),
  /** When set, the next starts are refused with this named error. */
  refusal: null as null | { code: string; status: number; message: string },

  start(params: Record<string, unknown>): unknown {
    if (mockGate.refusal) {
      throw Object.assign(new Error(mockGate.refusal.message), {
        code: mockGate.refusal.code,
        status: mockGate.refusal.status,
      });
    }
    const requested = String(params.engine ?? 'auto');
    const session: FakeSession = {
      voiceSessionId: `vs-${mockGate.sessions.size + 1}`,
      engine: requested === 'auto' ? 'local' : requested,
      thread: params.thread as FakeSession['thread'],
      deviceId: String(params.deviceId),
    };
    mockGate.sessions.set(session.voiceSessionId, session);
    return {
      voiceSessionId: session.voiceSessionId,
      engine: session.engine,
      streamPath: '/v1/voice/stream',
    };
  },

  stop(params: Record<string, unknown>): { stopped: true } {
    mockGate.sessions.delete(String(params.voiceSessionId));
    return { stopped: true };
  },
};

const mockGateway = {
  // A fake token for a fake Gate: nothing here leaves the process.
  activeGateway: { id: 'gw-home', url: 'http://127.0.0.1:8760', token: 'fake-token' },
  status: 'connected' as const,
  currentSessionId: 'ses_bot',
  selectedBotId: 'hermes',
  pendingRunApproval: null,
  sendChatInput: jest.fn(async () => 'sent' as const),
  gatewayRequest: jest.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'voice.session.start') return mockGate.start(params);
    if (method === 'voice.session.stop') return mockGate.stop(params);
    return { ok: true };
  }),
  reloadHistory: jest.fn(async () => undefined),
};

// One stable surface: a fresh object per render would re-run the provider's
// reply effect on every render, which is not what this file is about.
const mockSurface = { messages: [] as unknown[], isSending: false, isCommandRunning: false };
jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => mockGateway,
  useChatSurface: () => mockSurface,
}));

jest.mock('@/lib/notifications/push-registration', () => ({
  pushDeviceParams: jest.fn(async () => ({ deviceId: 'phone-abc12345' })),
}));

jest.mock('@/lib/voice/speech', () => ({
  beginHandsfreeCall: jest.fn(),
  endHandsfreeCall: jest.fn(),
  stopSpeech: jest.fn(async () => undefined),
}));

// ─── The native module, and the frames it reports ───────────────────────────

type Listener = (event: unknown) => void;

const mockListeners = new Map<string, Listener[]>();
const mockMediaStarts: { voiceSessionId: string; startId: string }[] = [];

const mockNative = {
  getAvailability: jest.fn(async () => ({
    recognition: false,
    synthesis: false,
    maxSpeechInputLength: 0,
  })),
  startSession: jest.fn(async () => 'started' as const),
  stopSession: jest.fn(async () => undefined),
  startListening: jest.fn(async () => true),
  stopListening: jest.fn(async () => undefined),
  speak: jest.fn(async () => true),
  stopSpeaking: jest.fn(async () => undefined),
  setMuted: jest.fn(async () => undefined),
  playSendEarcon: jest.fn(async () => undefined),
  startGateMedia: jest.fn(async (options: { voiceSessionId: string; startId: string }) => {
    mockMediaStarts.push(options);
    return true;
  }),
  sendGateControl: jest.fn(async () => true),
  stopGateMedia: jest.fn(async () => undefined),
  verifyLaunch: jest.fn(async () => true),
  addListener: jest.fn((event: string, listener: Listener) => {
    const existing = mockListeners.get(event) ?? [];
    existing.push(listener);
    mockListeners.set(event, existing);
    return { remove: () => undefined };
  }),
};

jest.mock('@/lib/voice/handsfree-device', () => ({
  loadHandsfreeModule: jest.fn(async () => mockNative),
}));

/** A frame the Gate sent, as the native side reports it. Synchronous. */
function gateFrame(frame: string): void {
  for (const listener of mockListeners.get('gate') ?? []) listener({ frame });
}

const ready = '{"t":"ready","engine":"local"}';
const listening = '{"t":"phase","phase":"listening"}';

// ─── The provider under test ────────────────────────────────────────────────

/** The newest published context value, held in a Map so the probe stays pure. */
const published = new Map<string, HandsfreeVoiceContextValue>();

function Probe() {
  const voice = useHandsfreeVoice();
  published.set('voice', voice);
  return null;
}

const latest = (): HandsfreeVoiceContextValue => {
  const voice = published.get('voice');
  if (!voice) throw new Error('the provider never rendered');
  return voice;
};

const target: HandsfreeCallTarget = {
  gatewayId: 'gw-home',
  sessionId: 'ses_bot',
  surfaceKind: 'bot',
  botId: 'hermes',
  label: 'Hermes',
  voice: {},
  transport: 'gate',
  voiceEngine: 'local',
};

let renderer: ReactTestRenderer | null = null;

beforeEach(async () => {
  jest.useFakeTimers();
  mockBacking.clear();
  mockGate.sessions.clear();
  mockGate.refusal = null;
  published.clear();
  mockMediaStarts.length = 0;
  mockListeners.clear();
  for (const fn of Object.values(mockNative)) {
    if (typeof fn === 'function') (fn as jest.Mock).mockClear();
  }
  mockGateway.gatewayRequest.mockClear();
  AppState.currentState = 'active';
  await act(async () => {
    renderer = create(
      createElement(HandsfreeVoiceProvider, null, createElement(Probe) as ReactNode),
    );
  });
  // The provider reads its gateway, session and availability asynchronously, so
  // a mount is only settled once those effects have run a turn of the queue.
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
});

afterEach(async () => {
  const current = renderer;
  renderer = null;
  if (current) {
    await act(async () => {
      current.unmount();
    });
  }
  jest.useRealTimers();
});

/**
 * Let an awaited chain run to its next park. The start is a chain of promises
 * (module load, availability, identity, grant, prompt, socket) and the Gate's
 * first frame has to arrive after the one it parks on — the link proof.
 */
async function settleChain(): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await jest.advanceTimersByTimeAsync(0);
  }
}

/** Run `body` as the one `act` of this interaction. */
async function call(body: () => Promise<void> | void): Promise<void> {
  await act(async () => {
    await body();
  });
}

/** A call the fake Gate really opens: the socket is up and the Gate speaks. */
async function startLiveCall(): Promise<void> {
  let result = '';
  await call(async () => {
    const starting = latest().start(target);
    await settleChain();
    gateFrame(ready);
    gateFrame(listening);
    result = (await starting).result;
  });
  expect(result).toBe('started');
  expect(latest().phase).toBe('listening');
}

// ─── A start that opens a call ──────────────────────────────────────────────

describe('a hands-free start against a fake Gate', () => {
  test('opens a call, with a session id, an engine and the Bot thread', async () => {
    await startLiveCall();

    // The Gate really opened a session — not just "the provider did not error".
    expect(mockGate.sessions.size).toBe(1);
    const opened = [...mockGate.sessions.values()][0]!;
    expect(opened.voiceSessionId).toMatch(/^vs-/);
    expect(opened.engine).toBe('local');
    expect(opened.deviceId).toBe('phone-abc12345');
    expect(opened.thread).toEqual({ kind: 'bot', sessionId: 'ses_bot', botId: 'hermes' });

    // The start asked for that call with this phone's identity and this Bot.
    expect(mockGateway.gatewayRequest).toHaveBeenCalledWith(
      'voice.session.start',
      expect.objectContaining({
        engine: 'local',
        thread: { kind: 'bot', sessionId: 'ses_bot', botId: 'hermes' },
        deviceId: 'phone-abc12345',
      }),
    );

    // The phone joined its audio link to that exact session id.
    expect(mockMediaStarts).toEqual([
      expect.objectContaining({ voiceSessionId: opened.voiceSessionId }),
    ]);

    // And the observable call state says so: live, on the local engine, for
    // this Bot, with a start time the banner can count from.
    expect(latest().active).toBe(true);
    expect(latest().phase).toBe('listening');
    expect(latest().engine).toBe('local');
    expect(latest().label).toBe('Hermes');
    expect(latest().startedAtMs).toBeGreaterThan(0);
  });
});

// ─── A start the fake Gate refuses ──────────────────────────────────────────

describe('a hands-free start the fake Gate refuses', () => {
  test('opens nothing, settles at idle, and the same provider can retry', async () => {
    mockGate.refusal = {
      code: 'no_engine',
      status: 409,
      message: 'The PC voice models are not installed.',
    };

    let result = '';
    let detail = '';
    await call(async () => {
      const attempt = await latest().start(target);
      result = attempt.result;
      detail = attempt.detail ?? '';
    });

    // The Gate's own refusal reaches the caller instead of becoming a generic
    // `unavailable`, and nothing was opened behind it.
    expect(result).toBe('no-engine');
    expect(detail).toMatch(/not installed/);
    expect(mockGate.sessions.size).toBe(0);
    expect(mockNative.startSession).not.toHaveBeenCalled();
    expect(mockMediaStarts).toHaveLength(0);

    // Settled: not stuck on "Starting", not a call, and ready to be asked again.
    expect(latest().phase).toBe('idle');
    expect(latest().active).toBe(false);
    expect(latest().canStart).toBe(true);

    // Retryable in the same provider, without a remount: the refusal was the
    // Gate's precondition, and it is gone.
    mockGate.refusal = null;
    await startLiveCall();
    expect(mockGate.sessions.size).toBe(1);
    expect([...mockGate.sessions.values()][0]!.engine).toBe('local');
  });
});
