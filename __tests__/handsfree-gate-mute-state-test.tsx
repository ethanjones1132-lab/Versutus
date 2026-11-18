// ─── One mute state, on every surface (VS-123) ──────────────────────────────
// A Gate call has three surfaces that can say whether the microphone is open:
// the in-app banner, the ongoing notification, and the Gate itself. The Gate's
// own `phase` frame is the authority; the phone folds Mute immediately and then
// holds that fold only when the Gate confirms it.
//
// Two things broke that: the fold dropped any v2 frame whose seq was not exactly
// last + 1 — so one frame the phone never saw (the native socket drops anything
// over its 4 KiB ceiling, and backpressure burns a sequence without sending it)
// froze the banner for the rest of the call, mute included — and a mute the Gate
// never confirmed was put back to "Listening" without asking the microphone,
// which the notification and the native capture had already muted.
//
// The native module is the seam, as in `handsfree-gate-call-truth-test.tsx`:
// frames are delivered through the `gate` listener, the notification through
// `muteRequest`, exactly as the service reports them.

import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState } from 'react-native';

import {
  HandsfreeVoiceProvider,
  useHandsfreeVoice,
  type HandsfreeCallTarget,
  type HandsfreeVoiceContextValue,
} from '@/context/handsfree-voice-provider';

/** The provider's own confirm window: how long an optimistic fold waits. */
const GATE_MUTE_CONFIRM_MS = 5_000;

const mockSharedLevel = { value: 0 };
jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
  useSharedValue: () => mockSharedLevel,
}));

const mockBacking = new Map<string, string>();
jest.mock('@/lib/voice/call-cues', () => ({
  callCues: {
    ready: jest.fn(async () => undefined),
    sent: jest.fn(async () => undefined),
  },
}));
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

const mockGateway = {
  activeGateway: { id: 'gw-home', url: 'http://127.0.0.1:8760', token: 'tok' },
  status: 'connected' as const,
  currentSessionId: 'ses_bot',
  selectedBotId: 'hermes',
  pendingRunApproval: null,
  sendChatInput: jest.fn(async (..._args: unknown[]) => 'sent' as const),
  gatewayRequest: jest.fn(async (method: string) =>
    method === 'voice.session.start'
      ? { voiceSessionId: 'vs-1', streamPath: '/v1/voice/stream', engine: 'local' }
      : { stopped: true },
  ),
  reloadHistory: jest.fn(async () => undefined),
};
const mockSurface = { messages: [] as unknown[], isSending: false, isCommandRunning: false };
jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => mockGateway,
  // One stable object: a fresh identity every render would re-run the provider's
  // reply effect on every render, which is not what these tests are about.
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

// ─── The native module, and the frames it reports ────────────────────────────

type Listener = (event: unknown) => void;

const mockListeners = new Map<string, Listener[]>();
const mockControls: string[] = [];
/** What the microphone's own capture flag says, read by `isMuted`. */
let mockCaptureMuted = false;

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
  setMuted: jest.fn(async (muted: boolean) => {
    mockCaptureMuted = muted;
  }),
  isMuted: jest.fn(() => mockCaptureMuted),
  playSendEarcon: jest.fn(async () => undefined),
  startGateMedia: jest.fn(async (_options: { voiceSessionId: string }) => true),
  sendGateControl: jest.fn(async (json: string) => {
    mockControls.push(json);
    return true;
  }),
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

/** A Gate frame, as the native socket forwarded it. Synchronous. */
function gateFrame(frame: string): void {
  for (const listener of mockListeners.get('gate') ?? []) listener({ frame });
}

/** An event the call service reports. Synchronous. */
function nativeEvent(event: string, payload: Record<string, unknown> = {}): void {
  for (const listener of mockListeners.get(event) ?? []) listener(payload);
}

/**
 * One v2 frame. The Gate numbers every frame of a call, and the phone folds
 * only the ones it can place; that numbering is what these tests are about.
 */
function v2(seq: number, body: Record<string, unknown>): string {
  return JSON.stringify({ v: 2, callId: 'vs-1', seq, ts: seq * 10, ...body });
}

const opening = v2(1, { t: 'call', state: 'opening' });
const ready = v2(2, { t: 'ready', engine: 'local' });
const listening = v2(3, { t: 'phase', phase: 'listening' });
const thinking = (seq: number) => v2(seq, { t: 'phase', phase: 'thinking' });
const mutedPhase = (seq: number) => v2(seq, { t: 'phase', phase: 'muted' });
const speakingPhase = (seq: number) => v2(seq, { t: 'phase', phase: 'speaking' });

// ─── The provider under test ────────────────────────────────────────────────

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
let warn: jest.SpyInstance;

beforeEach(async () => {
  jest.useFakeTimers();
  mockBacking.clear();
  mockSharedLevel.value = 0;
  published.clear();
  mockListeners.clear();
  mockControls.length = 0;
  mockCaptureMuted = false;
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  for (const fn of Object.values(mockNative)) {
    if (typeof fn === 'function') (fn as jest.Mock).mockClear();
  }
  // `isMuted` keeps its implementation; only the call history is cleared.
  mockNative.isMuted.mockImplementation(() => mockCaptureMuted);
  AppState.currentState = 'active';
  await act(async () => {
    renderer = create(
      createElement(HandsfreeVoiceProvider, null, createElement(Probe) as ReactNode),
    );
  });
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
  warn.mockRestore();
  jest.useRealTimers();
});

const call = async (body: () => Promise<void> | void): Promise<void> => {
  await act(async () => {
    await body();
  });
};

const settleChain = async (): Promise<void> => {
  for (let round = 0; round < 8; round += 1) {
    await jest.advanceTimersByTimeAsync(0);
  }
};

/** A live v2 Gate call, folded through the same three frames a real one sends. */
async function startLiveCall(): Promise<void> {
  let result = '';
  await call(async () => {
    const starting = latest().start(target);
    await settleChain();
    gateFrame(opening);
    gateFrame(ready);
    gateFrame(listening);
    result = (await starting).result;
  });
  expect(result).toBe('started');
  expect(latest().phase).toBe('listening');
}

describe('a v2 frame the phone never saw does not freeze the mute', () => {
  test('the frame after a gap is folded, so a mute still reaches the banner', async () => {
    await startLiveCall();

    await call(async () => {
      // Seq 4 never reached JS: the native socket drops a frame it cannot read
      // (its own ceiling is 4 KiB) and backpressure burns a sequence without
      // sending it. The Gate's mute confirmation is seq 5.
      gateFrame(mutedPhase(5));
    });

    expect(latest().phase).toBe('muted');
    expect(latest().muted).toBe(true);

    await call(async () => {
      // And the cursor moved: the frames after the hole are folded too, rather
      // than every one of them being dropped for the rest of the call.
      gateFrame(speakingPhase(6));
    });
    expect(latest().phase).toBe('speaking');
    expect(latest().muted).toBe(false);
  });

  test('the gap is named once per call, not once per frame', async () => {
    await startLiveCall();
    await call(async () => {
      gateFrame(mutedPhase(5));
      gateFrame(speakingPhase(9));
    });
    const gaps = warn.mock.calls.filter(([line]) => String(line).includes('frame gap'));
    expect(gaps).toHaveLength(1);
    expect(String(gaps[0][0])).toContain('expected=4 got=5');
  });
});

describe('the app mute is one state on the banner, the shade and the Gate', () => {
  test('a mute the Gate confirms stays muted, and the notification follows', async () => {
    await startLiveCall();

    await call(async () => {
      latest().mute();
    });
    expect(latest().muted).toBe(true);
    expect(mockControls).toEqual(['{"t":"mute","on":true}']);
    // The ongoing notification draws its label and body from the service, so
    // the in-app control has to be the same state the shade shows (VS-123).
    expect(mockNative.setMuted).toHaveBeenCalledWith(true);

    await call(async () => {
      gateFrame(mutedPhase(4));
      await jest.advanceTimersByTimeAsync(30_000);
    });

    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('the Gate never confirmed the mute'),
    );
    expect(latest().phase).toBe('muted');
    expect(latest().muted).toBe(true);

    await call(async () => {
      latest().unmute();
    });
    expect(latest().muted).toBe(false);
    expect(mockNative.setMuted).toHaveBeenLastCalledWith(false);
  });

  test('the Gate confirming a mute taken during a turn in flight keeps it', async () => {
    await startLiveCall();
    await call(async () => {
      gateFrame(thinking(4));
    });
    expect(latest().phase).toBe('sending');

    await call(async () => {
      latest().mute();
      // The Gate now answers a mute from `thinking` with its own phase; the
      // frame is the confirmation, not the silence that used to follow.
      gateFrame(mutedPhase(5));
      await jest.advanceTimersByTimeAsync(30_000);
    });

    expect(latest().phase).toBe('muted');
    expect(latest().muted).toBe(true);
    expect(latest().sendingSinceMs).toBeNull();
  });
});

describe('a mute the Gate never confirmed is checked against the microphone', () => {
  test('a capture that really is muted stays muted instead of claiming Listening', async () => {
    await startLiveCall();
    await call(async () => {
      latest().mute();
    });
    expect(latest().muted).toBe(true);

    await call(async () => {
      await jest.advanceTimersByTimeAsync(GATE_MUTE_CONFIRM_MS + 1_000);
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('captureMuted=true'));
    expect(latest().muted).toBe(true);
    expect(latest().phase).toBe('muted');
  });

  test('a capture the phone did not mute is still put back, and says so', async () => {
    await startLiveCall();
    await call(async () => {
      // Nothing muted the microphone: the service refused the change, so the
      // capture flag never moved and the control frame never took effect.
      mockNative.setMuted.mockImplementationOnce(async () => undefined);
      mockCaptureMuted = false;
      latest().mute();
    });
    expect(latest().muted).toBe(true);

    await call(async () => {
      await jest.advanceTimersByTimeAsync(GATE_MUTE_CONFIRM_MS + 1_000);
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the Gate never confirmed the mute'));
    expect(latest().phase).toBe('listening');
    expect(latest().muted).toBe(false);
  });
});

describe("the notification's Mute is the same path as the banner's", () => {
  test('a replayed phase cannot hide the notification mute taken during reconnect', async () => {
    await startLiveCall();
    await call(async () => {
      gateFrame('{"t":"error","code":"socket_failed","message":"link dropped","fatal":true}');
      mockCaptureMuted = true;
      mockNative.sendGateControl.mockResolvedValueOnce(false);
      nativeEvent('muteRequest', { muted: true });
      await jest.advanceTimersByTimeAsync(500);
      gateFrame(opening); // The original hello proves the re-attach before replay.
      await jest.advanceTimersByTimeAsync(0);
      gateFrame(v2(4, { t: 'phase', phase: 'listening' }));
    });
    expect(mockNative.startGateMedia).toHaveBeenCalledTimes(2);
    expect(latest().phase).toBe('muted');
    expect(latest().muted).toBe(true);

    await call(() => gateFrame(mutedPhase(5)));
    expect(latest().audioStatus).toBeUndefined();
    expect(latest().muted).toBe(true);
  });

  test('a notification mute reaches the Gate control and the banner', async () => {
    await startLiveCall();

    await call(async () => {
      // The service applied it to the capture already (that is what keeps a
      // call muted with no JS runtime) and reports the same tap to JS.
      mockCaptureMuted = true;
      nativeEvent('muteRequest', { muted: true });
    });

    expect(latest().muted).toBe(true);
    expect(mockControls).toEqual(['{"t":"mute","on":true}']);

    await call(async () => {
      gateFrame(mutedPhase(4));
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(latest().phase).toBe('muted');
    expect(latest().muted).toBe(true);
  });

  test('a notification unmute reopens the microphone on both surfaces', async () => {
    await startLiveCall();
    await call(async () => {
      gateFrame(mutedPhase(4));
    });
    expect(latest().muted).toBe(true);

    await call(async () => {
      mockCaptureMuted = false;
      nativeEvent('muteRequest', { muted: false });
    });

    expect(latest().muted).toBe(false);
    expect(mockControls).toEqual(['{"t":"mute","on":false}']);
  });
});
