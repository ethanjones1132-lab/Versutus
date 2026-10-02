// ─── Hands-free on the phone tells the truth ───────────────────────────────
// The operator's report: "My voice was read initially late, sent early, and was
// chaos after that." Every one of those is a phone-side lie about a Gate call:
//
//   • the banner said "Listening" on an audio link the Gate was never on, for
//     minutes, with nothing heard, nothing sent and no end reason;
//   • a turn that died was invisible, so the call sat on "Sending" while the
//     slow-turn counter counted on;
//   • a call that died before the Gate delivered a turn lost what was said;
//   • a mute the Gate never applied stayed on the label.
//
// The native module is the seam: `startGateMedia` answers `true` the moment the
// socket is handed over (OkHttp is asynchronous), and every real failure arrives
// later as a frame. These drive the provider through that seam with real timers.
//
// One rule holds this file together: every interaction is ONE `act`. Frames are
// delivered synchronously inside it rather than from an `act` of their own,
// because a nested act leaves React's queue open and every later mount in the
// file then renders nothing.

import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState } from 'react-native';

import {
  HANDSFREE_GRACE_MS,
  HANDSFREE_REPLY_WATCHDOG_MS,
  HandsfreeVoiceProvider,
  useHandsfreeVoice,
  type HandsfreeCallTarget,
  type HandsfreeVoiceContextValue,
} from '@/context/handsfree-voice-provider';
import { recoveryStorageKey } from '@/lib/gateway/composer-draft';
import { handsfreeEndReasonCopy, handsfreeTurnFailureCopy } from '@/lib/voice/handsfree-call-copy';

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

const mockMessages: { messages: unknown[] } = { messages: [] };
jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => mockGateway,
  // One stable array: a fresh identity every render would re-run the provider's
  // reply effect on every render, which is not what any of these tests is about.
  useChatSurface: () => ({ ...mockMessages, isSending: false, isCommandRunning: false }),
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
const mockMediaStarts: { voiceSessionId: string }[] = [];
const mockControls: string[] = [];
/** False to model a socket that is handed over but never carries the Gate. */
let mockMediaAnswers = true;

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
  startGateMedia: jest.fn(async (options: { voiceSessionId: string }) => {
    mockMediaStarts.push(options);
    return mockMediaAnswers;
  }),
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

/** A frame the Gate sent, as the native side reports it. Synchronous. */
function gateFrame(frame: string): void {
  for (const listener of mockListeners.get('gate') ?? []) listener({ frame });
}

/** An event the phone engine's own listeners report. Synchronous. */
function nativeEvent(event: string, payload: Record<string, unknown> = {}): void {
  for (const listener of mockListeners.get(event) ?? []) listener(payload);
}

/** Re-render the tree, as any context update would, without touching call state. */
function repaint(): void {
  renderer!.update(
    createElement(HandsfreeVoiceProvider, null, createElement(Probe) as ReactNode),
  );
}

const ready = '{"t":"ready","engine":"local"}';
const readyWithWindow = '{"t":"ready","engine":"local","resumeWindowMs":90000}';
const listening = '{"t":"phase","phase":"listening"}';
const thinking = '{"t":"phase","phase":"thinking"}';
const speaking = '{"t":"phase","phase":"speaking"}';
const mutedPhase = '{"t":"phase","phase":"muted"}';
const socketFailed =
  '{"t":"error","code":"socket_failed","message":"Expected HTTP 101","fatal":true}';
const socketClosed =
  '{"t":"error","code":"socket_closed","message":"The PC closed the call audio link.","fatal":true}';

// ─── The provider under test ────────────────────────────────────────────────

/** Every context value the provider published, in order. */
let seen: HandsfreeVoiceContextValue[] = [];
/** The newest published value, held in a Map so the probe stays pure. */
const published = new Map<string, HandsfreeVoiceContextValue>();

function Probe() {
  const voice = useHandsfreeVoice();
  seen.push(voice);
  published.set('voice', voice);
  return null;
}

const latest = (): HandsfreeVoiceContextValue => {
  const voice = published.get('voice');
  if (!voice) throw new Error('the provider never rendered');
  return voice;
};

const thread = {
  gatewayId: 'gw-home',
  surface: { kind: 'bot' as const, botId: 'hermes' },
  sessionId: 'ses_bot',
};
const draftKey = 'composer-draft:gw-home:bot:hermes:ses_bot';
const recoveryKey = recoveryStorageKey(thread);

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
  mockMessages.messages = [];
  seen = [];
  published.clear();
  mockMediaStarts.length = 0;
  mockControls.length = 0;
  mockMediaAnswers = true;
  mockListeners.clear();
  for (const fn of Object.values(mockNative)) {
    if (typeof fn === 'function') (fn as jest.Mock).mockClear();
  }
  mockGateway.gatewayRequest.mockClear();
  mockGateway.sendChatInput.mockClear();
  AppState.currentState = 'active';
  await act(async () => {
    renderer = create(
      createElement(HandsfreeVoiceProvider, null, createElement(Probe) as ReactNode),
    );
  });
  // The provider reads its gateway, session and availability asynchronously, so a
  // mount is only settled once those effects have run a turn of the queue.
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

const phases = () => seen.map((value) => value.phase);

/**
 * Let an awaited chain run to its next park. The start is a chain of promises
 * (module load, availability, identity, grant, prompt, socket) and the frame has
 * to be delivered after the one it parks on — the link proof — not before it.
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

/** A call whose link never carries the Gate: the start is left to time out. */
async function startUnprovedCall(): Promise<string> {
  let result = '';
  await call(async () => {
    const starting = latest().start(target);
    await jest.advanceTimersByTimeAsync(11_000);
    result = (await starting).result;
  });
  return result;
}

/** A call the Gate really is on: the socket opened and the Gate spoke on it. */
async function startLiveCall(readyFrame: string = ready): Promise<void> {
  let result = '';
  await call(async () => {
    const starting = latest().start(target);
    await settleChain();
    gateFrame(readyFrame);
    gateFrame(listening);
    result = (await starting).result;
  });
  expect(result).toBe('started');
  expect(latest().phase).toBe('listening');
}

describe('a Gate call whose link never comes up', () => {
  test('never paints Listening, and fails the start instead of listening to nothing', async () => {
    // The socket is handed over and answers `true`; the Gate is never on it.
    expect(await startUnprovedCall()).toBe('media-start-failed');
    // Not once did the banner claim the call could hear anything, and the call
    // is back at idle so the operator can press Call again.
    expect(phases()).not.toContain('listening');
    expect(latest().phase).toBe('idle');
    expect(latest().canStart).toBe(true);
    // The grant is released, so the retry is not refused as call-in-progress.
    expect(mockGateway.gatewayRequest).toHaveBeenCalledWith('voice.session.stop', {
      voiceSessionId: 'vs-1',
      reason: 'start-failed',
    });
  });

  test('a socket that dies before the Gate speaks is the same failed attempt', async () => {
    let result = '';
    await call(async () => {
      const starting = latest().start(target);
      await settleChain();
      gateFrame(socketFailed);
      result = (await starting).result;
    });
    expect(result).toBe('media-start-failed');
    expect(phases()).not.toContain('listening');
    expect(latest().phase).toBe('idle');
  });

  test('a link the Gate speaks on immediately is a call', async () => {
    await startLiveCall();
    expect(mockMediaStarts).toHaveLength(1);
    expect(latest().active).toBe(true);
  });
});

describe('a call that loses its link mid-way', () => {
  test('the resume window is spent re-opening it, then the call ends with its own reason', async () => {
    await startLiveCall();
    await call(async () => {
      // The socket dies and no re-attached socket ever carries the Gate. Every
      // attempt inside the Gate's resume window answers `true` and proves nothing.
      gateFrame(socketFailed);
      await jest.advanceTimersByTimeAsync(25_000);
    });

    // The call is over, and it says why: the link dropped, which is not the same
    // fact as the operator ending it.
    expect(latest().active).toBe(false);
    expect(latest().lastEndReason).toBe('link-lost');
    expect(handsfreeEndReasonCopy('link-lost')).toMatch(/audio link to the PC dropped/);
    // The window was actually spent on attempts — not one, and not forever.
    expect(mockMediaStarts.length).toBeGreaterThan(1);
    expect(mockMediaStarts.length).toBeLessThan(12);
    // The media is torn down on the way out.
    expect(mockNative.stopGateMedia).toHaveBeenCalled();
  });

  test('the resume window the Gate advertises bounds the re-attach, not a hard-coded 20 s', async () => {
    await startLiveCall(readyWithWindow);
    await call(async () => {
      gateFrame(socketFailed);
      // The Gate said it holds the call for 90 s. At 25 s — past the 20 s the
      // phone used to keep — it must still be trying, not have ended the call.
      await jest.advanceTimersByTimeAsync(25_000);
    });
    expect(latest().active).toBe(true);
    expect(latest().lastEndReason).toBeUndefined();
    expect(mockMediaStarts.length).toBeGreaterThan(1);

    // At the end of the window it gives up, with the same reason as before.
    await call(async () => {
      await jest.advanceTimersByTimeAsync(120_000);
    });
    expect(latest().active).toBe(false);
    expect(latest().lastEndReason).toBe('link-lost');
  });

  test('a later socket failure cannot restart the loop the window already ended', async () => {
    await startLiveCall();
    await call(async () => {
      gateFrame(socketFailed);
      await jest.advanceTimersByTimeAsync(25_000);
    });
    const attemptsAtEnd = mockMediaStarts.length;
    expect(latest().lastEndReason).toBe('link-lost');

    await call(async () => {
      // A stale socket keeps reporting its own death after the call is over.
      gateFrame(socketFailed);
      gateFrame(socketFailed);
      await jest.advanceTimersByTimeAsync(25_000);
    });

    expect(mockMediaStarts.length).toBe(attemptsAtEnd);
    expect(latest().lastEndReason).toBe('link-lost');
  });

  test('a clean socket close is retried the same way a failed socket is', async () => {
    // The Gate holds a detached call for its resume window and closes without
    // an ended frame from idle timeout and restart. socket_closed used to skip
    // the reconnect path (only socket_failed was retryable) and end the call.
    await startLiveCall();
    await call(async () => {
      gateFrame(socketClosed);
      await jest.advanceTimersByTimeAsync(500);
      expect(mockMediaStarts.length).toBe(2);
      gateFrame(ready);
      await jest.advanceTimersByTimeAsync(1_000);
    });

    expect(latest().active).toBe(true);
    expect(latest().lastEndReason).toBeUndefined();
    expect(mockMediaStarts.length).toBe(2);
  });

  test('a link the Gate does rejoin keeps the call alive', async () => {
    await startLiveCall();
    await call(async () => {
      gateFrame(socketFailed);
      await jest.advanceTimersByTimeAsync(500);
      expect(mockMediaStarts.length).toBe(2);
      // The Gate re-attaches the same session and speaks on the new socket.
      gateFrame(ready);
      await jest.advanceTimersByTimeAsync(1_000);
    });

    expect(latest().active).toBe(true);
    expect(latest().phase).toBe('listening');
    expect(latest().lastEndReason).toBeUndefined();
    expect(mockMediaStarts.length).toBe(2);
  });

  test('a re-attach loop the operator replaced cannot end the call that replaced it', async () => {
    await startLiveCall(readyWithWindow);
    // The link blips and the re-attach loop starts spending the Gate's window.
    await call(async () => {
      gateFrame(socketFailed);
      // Fail the short attempts, then park in the long sleep at the tail of the
      // window — the stretch an End-then-redial happens inside.
      await jest.advanceTimersByTimeAsync(70_000);
    });
    expect(latest().active).toBe(true);

    // The operator ends the call and redials while the old loop is still asleep.
    await call(async () => {
      latest().end();
      await jest.advanceTimersByTimeAsync(50);
    });
    expect(latest().phase).toBe('idle');
    await startLiveCall(readyWithWindow);

    // The new call blips too, so its own loop is alive and parked in the same
    // tail — the flag the superseded loop must leave alone. This advance also
    // carries the first call's loop past the end of its own tail, where it
    // wakes to find a call it no longer owns.
    await call(async () => {
      gateFrame(socketFailed);
      await jest.advanceTimersByTimeAsync(70_000);
    });

    // The superseded loop has woken. The call it served is gone; it must not
    // report that call's dropped link against the live one.
    expect(latest().active).toBe(true);
    expect(latest().phase).toBe('listening');
    expect(latest().lastEndReason).toBeUndefined();
    const attemptsBefore = mockMediaStarts.length;

    // Nor may it clear the live loop's flag: one more socket death on the live
    // call is swallowed by the loop already running, not a second opener.
    await call(async () => {
      gateFrame(socketFailed);
      await jest.advanceTimersByTimeAsync(1_000);
    });
    expect(latest().active).toBe(true);
    expect(mockMediaStarts.length).toBe(attemptsBefore);
  });
});

describe('a Gate turn that failed is told to the operator', () => {
  test('the banner leaves Sending, names the failure, and the call carries on', async () => {
    await startLiveCall();
    await call(async () => {
      gateFrame(thinking);
    });
    expect(latest().phase).toBe('sending');

    await call(async () => {
      gateFrame('{"t":"turn","turnId":"t1","state":"failed","error":"the PC could not answer"}');
    });

    expect(latest().turnState).toBe('failed');
    expect(latest().turnError).toBe('the PC could not answer');
    expect(latest().phase).toBe('listening');
    expect(latest().active).toBe(true);
    // The "still waiting on the PC" line stops counting: nothing is pending.
    expect(latest().sendingSinceMs).toBeNull();
    expect(handsfreeTurnFailureCopy(latest().turnError)).toBe(
      'That turn could not be completed the PC could not answer',
    );

    // The next turn folds it away, so the line is shown once.
    await call(async () => {
      gateFrame('{"t":"final","turnId":"t2","text":"never mind"}');
    });
    expect(latest().turnError).toBeNull();
  });

  test('a non-fatal error is named once and does not end the call', async () => {
    await startLiveCall();
    await call(async () => {
      gateFrame(
        '{"t":"error","code":"engine_warmup","message":"the model is still loading","fatal":false}',
      );
    });

    expect(latest().active).toBe(true);
    expect(latest().turnError).toBe('the model is still loading');
    expect(handsfreeTurnFailureCopy(latest().turnError)).toMatch(/could not be completed/);

    // A fatal one is the end of the call, and still the Gate's own reason.
    await call(async () => {
      gateFrame('{"t":"error","code":"engine_error","message":"boom","fatal":true}');
    });
    expect(latest().active).toBe(false);
  });

  test('the copy folds to nothing when no turn has failed', () => {
    expect(handsfreeTurnFailureCopy(null)).toBeNull();
    expect(handsfreeTurnFailureCopy('   ')).toBeNull();
  });
});

describe('what was said survives a call that dies before the Gate delivers it', () => {
  test('a spoken final is recovered onto the composer when the call ends', async () => {
    await startLiveCall();
    await call(async () => {
      gateFrame('{"t":"final","turnId":"t1","text":"book a table for two"}');
    });
    expect(mockBacking.get(recoveryKey)).toBe(JSON.stringify('book a table for two'));

    // The operator ends the call before the Gate ever said the turn started.
    await call(async () => {
      latest().end();
      await jest.advanceTimersByTimeAsync(50);
    });

    // The words are in the composer, not lost: the terminal edge promoted them.
    expect(mockBacking.get(recoveryKey)).toBeUndefined();
    expect(JSON.parse(mockBacking.get(draftKey) ?? '""')).toBe('book a table for two');
  });

  test('a turn the Gate did start leaves nothing behind', async () => {
    await startLiveCall();
    await call(async () => {
      gateFrame('{"t":"final","turnId":"t1","text":"book a table for two"}');
      gateFrame('{"t":"turn","turnId":"t1","state":"sent"}');
    });
    expect(mockBacking.get(recoveryKey)).toBeUndefined();

    await call(async () => {
      latest().end();
      await jest.advanceTimersByTimeAsync(50);
    });

    // Delivered, so there is nothing to recover: the composer is untouched.
    expect(mockBacking.get(draftKey)).toBeUndefined();
  });

  test('a turn that failed keeps the words: they were never delivered', async () => {
    await startLiveCall();
    await call(async () => {
      gateFrame('{"t":"final","turnId":"t1","text":"book a table for two"}');
      gateFrame('{"t":"turn","turnId":"t1","state":"failed","error":"backend_error"}');
    });
    expect(mockBacking.get(recoveryKey)).toBe(JSON.stringify('book a table for two'));
  });
});

describe('a mute the Gate never applied cannot stand on the label', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  test('a phase frame that does not reflect the mute leaves the rollback running', async () => {
    await startLiveCall();
    await call(async () => {
      latest().mute();
    });
    expect(latest().muted).toBe(true);

    await call(async () => {
      // The Gate is already moving on a turn, so it sends the phase frame it was
      // already producing — before it read the control frame.
      gateFrame(thinking);
      await jest.advanceTimersByTimeAsync(4_000);
    });
    // Still waiting: that frame proved nothing about the mute.
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('the Gate never confirmed the mute'),
    );

    await call(async () => {
      await jest.advanceTimersByTimeAsync(2_000);
    });

    // The wait ran out and the fold was taken back, so the label cannot disagree
    // with a Gate that never muted anything.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('the Gate never confirmed the mute'),
    );
    expect(latest().muted).toBe(false);
    // The Gate's own phase is the one left on the banner, not the pre-mute one.
    expect(latest().phase).toBe('sending');
  });

  test('a phase frame that reflects the mute confirms it and keeps it', async () => {
    await startLiveCall();
    await call(async () => {
      latest().mute();
      gateFrame(mutedPhase);
      await jest.advanceTimersByTimeAsync(30_000);
    });

    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('the Gate never confirmed the mute'),
    );
    expect(latest().muted).toBe(true);
    expect(latest().phase).toBe('muted');
    // One control frame: the mute that was asked for.
    expect(mockControls).toEqual(['{"t":"mute","on":true}']);
  });

  test('an unmute the Gate ignored is put back at five seconds', async () => {
    await startLiveCall();
    await call(async () => {
      gateFrame(mutedPhase);
    });
    expect(latest().muted).toBe(true);

    await call(async () => {
      latest().unmute();
    });
    expect(latest().muted).toBe(false);

    await call(async () => {
      // The Gate is still holding the call muted, and says so again.
      gateFrame(mutedPhase);
      await jest.advanceTimersByTimeAsync(6_000);
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('the Gate never confirmed the mute'),
    );
    expect(latest().muted).toBe(true);
    expect(latest().phase).toBe('muted');
  });

  test('muting while a turn is in flight stops the slow-turn stamp, and a rollback restores it', async () => {
    await startLiveCall();
    await call(async () => {
      gateFrame(thinking);
    });
    expect(latest().sendingSinceMs).not.toBeNull();

    await call(async () => {
      latest().mute();
    });
    // Muted is not "waiting on the PC". Leaving the stamp here is what kept
    // "Still waiting on the PC… Ns" counting under Muted.
    expect(latest().phase).toBe('muted');
    expect(latest().sendingSinceMs).toBeNull();

    await call(async () => {
      await jest.advanceTimersByTimeAsync(6_000);
    });
    // The Gate never confirmed the mute, so thinking is put back — and the
    // wait clock with it.
    expect(latest().phase).toBe('sending');
    expect(latest().muted).toBe(false);
    expect(latest().sendingSinceMs).not.toBeNull();
  });

  test('a phase frame is the whole account of the mute, label and flag together', async () => {
    await startLiveCall();
    await call(async () => {
      gateFrame(speaking);
    });
    // The Gate says it is speaking, so the call is not muted — whatever the
    // optimistic fold said a moment ago.
    expect(latest().muted).toBe(false);

    await call(async () => {
      gateFrame(mutedPhase);
    });
    expect(latest().muted).toBe(true);
    expect(latest().phase).toBe('muted');
  });
});
describe('a Gate approval is visible on the call, not dropped', () => {
  test('an approval frame is published on the context so the banner can name it', async () => {
    await startLiveCall();
    await call(async () => {
      gateFrame(thinking);
      gateFrame('{"t":"approval","turnId":"t1","summary":"Run ls?"}');
    });
    expect(latest().approval).toEqual({ turnId: 't1', summary: 'Run ls?' });
    expect(latest().phase).toBe('sending');
    expect(latest().active).toBe(true);
  });
});

describe('a reply that appears with no words in it does not park the call', () => {
  const phoneTarget: HandsfreeCallTarget = { ...target, transport: 'phone' };

  /** A phone-engine call, with a turn sent and the reply the send created. */
  async function sendPhoneTurn(text: string): Promise<string> {
    mockNative.getAvailability.mockResolvedValue({
      recognition: true,
      synthesis: true,
      maxSpeechInputLength: 200,
    });
    await call(async () => {
      expect((await latest().start(phoneTarget)).result).toBe('started');
    });
    await call(async () => {
      nativeEvent('final', { text });
      // The grace window elapses and the turn is sent with the id it made.
      await jest.advanceTimersByTimeAsync(HANDSFREE_GRACE_MS + 100);
    });
    const options = mockGateway.sendChatInput.mock.calls[0]?.[1] as
      | { messageId: string }
      | undefined;
    if (!options) throw new Error('the turn was never sent');
    return options.messageId;
  }

  /** The assistant row that answers `turnId`, with exactly this much in it. */
  function reply(turnId: string, text: string, streaming = true): void {
    mockMessages.messages = [
      { id: turnId, role: 'user', text: 'book a table' },
      { id: 'r1', role: 'assistant', text, streaming },
    ];
  }

  test('an empty reply reopens the microphone instead of waiting forever', async () => {
    const turnId = await sendPhoneTurn('book a table');
    await call(async () => {
      // The reply row appeared with nothing in it: the turn left, and no word of
      // the answer has arrived.
      reply(turnId, '');
      repaint();
    });
    expect(latest().phase).toBe('waiting');

    await call(async () => {
      await jest.advanceTimersByTimeAsync(HANDSFREE_REPLY_WATCHDOG_MS + 1_000);
    });

    // The watchdog was discharged by the reply appearing, and re-armed while the
    // reply stayed silent: the call reopens for the next turn rather than sitting
    // in Waiting with the microphone shut.
    expect(latest().phase).toBe('listening');
    expect(latest().active).toBe(true);
    expect(mockNative.startListening).toHaveBeenCalled();
  });

  test('a reply that keeps producing words is not cut off by the watchdog', async () => {
    const turnId = await sendPhoneTurn('book a table');
    await call(async () => {
      reply(turnId, '');
      repaint();
    });
    await call(async () => {
      await jest.advanceTimersByTimeAsync(HANDSFREE_REPLY_WATCHDOG_MS - 1_000);
    });

    // A delta arrives while the reply is still streaming: the reply is making
    // progress, so the watch is armed again from here rather than expiring.
    await call(async () => {
      reply(turnId, 'A table for');
      repaint();
    });
    expect(latest().phase).toBe('speaking');

    await call(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(latest().phase).toBe('speaking');
    expect(latest().active).toBe(true);
  });

  test('a reply that finished streaming is read to the end, however long that takes', async () => {
    const turnId = await sendPhoneTurn('book a table');
    await call(async () => {
      reply(turnId, '');
      repaint();
    });
    // The first words arrive and the call starts speaking...
    await call(async () => {
      reply(turnId, 'A table for', true);
      repaint();
    });
    expect(latest().phase).toBe('speaking');
    // ...then the whole answer has arrived (a long one streams faster than it is
    // spoken) and the stream is finished.
    await call(async () => {
      reply(turnId, 'A table for two at eight. '.repeat(40), false);
      repaint();
    });
    expect(latest().phase).toBe('speaking');

    // Reading it aloud takes longer than the watchdog's whole budget. Nothing is
    // wrong with that reply, so the call must not fail it and reopen the mic.
    await call(async () => {
      await jest.advanceTimersByTimeAsync(HANDSFREE_REPLY_WATCHDOG_MS + 30_000);
    });
    expect(latest().phase).toBe('speaking');
    expect(latest().active).toBe(true);
  });

  test('a reply that is still streaming but has stopped producing is failed by the watchdog', async () => {
    const turnId = await sendPhoneTurn('book a table');
    await call(async () => {
      reply(turnId, '');
      repaint();
    });
    await call(async () => {
      reply(turnId, 'A table for');
      repaint();
    });
    expect(latest().phase).toBe('speaking');
    // One more delta once it is speaking: the watch is armed again from it.
    await call(async () => {
      reply(turnId, 'A table for two');
      repaint();
    });

    // The stream stalls: no further text, still marked streaming.
    await call(async () => {
      await jest.advanceTimersByTimeAsync(HANDSFREE_REPLY_WATCHDOG_MS + 5_000);
    });
    expect(latest().phase).toBe('listening');
    expect(mockNative.startListening).toHaveBeenCalled();
  });
});
