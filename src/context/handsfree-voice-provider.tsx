// ─── The hands-free call, orchestrated above navigation ───────────────────
// Mounted inside `GatewayProvider` and outside `FontProvider`/navigation, so a
// route change, a backgrounded app or the app lock never unmounts a call. It
// owns no native code itself: the pure reducer (`handsfree-session.ts`) decides
// the turn, this file turns the reducer's effects into native calls, and every
// backend stays the same text-chat contract the rest of the app already uses.
//
// The call target is built by the caller (the chat screen holds the surface,
// the draft thread and the per-Bot voice; none is readable from context), and
// handed to `start(target)`. Afterwards the provider watches the gateway,
// session and Bot it captured and ends the call the moment any of them moves:
// a call is a live conversation with one thread, and sending speech into a
// different one is the failure this guards against.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';
import { useSharedValue } from 'react-native-reanimated';

import { useChatSurface, useGateway } from '@/context/gateway-provider';
import { composerDraftThread, type ComposerDraftThread } from '@/lib/gateway/composer-draft';
import { createMessageId } from '@/lib/gateway/messages';
import {
  INITIAL_GATE_CALL,
  appPhaseForGate,
  gateControlFor,
  reduceGateCall,
  serializeGateControl,
  type GateCallBanner,
  type GateCallEffect,
  type HandsfreeCallTransport,
} from '@/lib/voice/gate-call';
import { createGateLinkProbe, isGateSocketGone } from '@/lib/voice/gate-link';
import { isDeviceIdentityError } from '@/lib/gateway/errors';
import { recordFailure } from '@/lib/diagnostics/failure-log';
import { pushDeviceParams } from '@/lib/notifications/push-registration';
import { reconnectGateMedia } from '@/lib/voice/gate-reconnect';
import { loadHandsfreeModule, type HandsfreeNativeModule } from '@/lib/voice/handsfree-device';
import {
  cancelNativeStart,
  newHandsfreeStartId,
  openGateVoiceSession,
} from '@/lib/voice/handsfree-start-attempt';
import {
  evaluateHandsfreeStart,
  handsfreeDeviceCanOfferCall,
  logHandsfreeStart,
  type GateVoiceGrant,
  type HandsfreeStartAttempt,
  type HandsfreeStartResult,
} from '@/lib/voice/handsfree-start-reason';
import { parseGateFrame, type GateVoiceFrame, type VoicePhase } from '@/lib/voice/voice-stream-protocol';
import {
  handsfreeReplyForTurn,
  isFailedReply,
  planHandsfreeSpeech,
  type HandsfreeSpeechCursor,
} from '@/lib/voice/handsfree-reply';
import {
  clearHandsfreeRecovery,
  promoteHandsfreeRecovery,
  saveHandsfreeRecovery,
} from '@/lib/voice/handsfree-recovery';
import {
  INITIAL_HANDSFREE_SESSION,
  reduceHandsfreeSession,
  type HandsfreeEffect,
  type HandsfreeEvent,
  type HandsfreePhase,
  type HandsfreeSessionState,
  type HandsfreeTerminalReason,
} from '@/lib/voice/handsfree-session';
import {
  handsfreeStartBlocker,
  type HandsfreeStartBlocker,
} from '@/lib/voice/handsfree-start-policy';
import { beginHandsfreeCall, endHandsfreeCall, stopSpeech } from '@/lib/voice/speech';
import { isStartTimeout, startDeadline } from '@/lib/voice/start-deadline';
import type { HandsfreeAvailability, HandsfreeStartOutcome } from '../../modules/handsfree-voice';

/** How long a silence-triggered final is held before it sends. */
export const HANDSFREE_GRACE_MS = 600;

/** How long a sent turn may wait for its reply before the call fails. */
export const HANDSFREE_REPLY_WATCHDOG_MS = 120_000;

/** How many times a listen that did not start is asked again before the call ends. */
const HANDSFREE_LISTEN_RETRY_LIMIT = 8;
const HANDSFREE_LISTEN_RETRY_MS = 150;

/** A probe that finds no recognizer is asked again; Samsung binds its recognition service lazily. */
const HANDSFREE_PROBE_RETRIES = 3;
const HANDSFREE_PROBE_RETRY_MS = 500;

/**
 * A chunk the platform refused is offered again this often, this many times.
 * Android answers a plain `false` when its service is momentarily gone, and a
 * chunk recorded as spoken is never offered again — so a refusal has to be a
 * retry, not a silent loss.
 */
const HANDSFREE_SPEAK_RETRY_MS = 250;
const HANDSFREE_SPEAK_RETRY_LIMIT = 5;

/**
 * How long an optimistic Gate mute waits for the Gate's own `phase` frame
 * before the banner is put back. Long enough for a socket that is only slow,
 * short enough that a mute nobody can confirm is not read as a mute that
 * happened.
 */
const GATE_MUTE_CONFIRM_MS = 5_000;

/** What one call is for. Built by the caller, never derived from context. */
export type HandsfreeCallTarget = {
  gatewayId: string;
  sessionId: string;
  surfaceKind: 'configurable' | 'bot';
  botId?: string;
  label: string;
  voice: { voiceIdentifier?: string; rate?: number; pitch?: number };
  /**
   * Who drives the loop. `phone` (the default) is the Phase 0 on-device call;
   * `gate` hands the microphone, speaker and loop to the Gate. The provider
   * branches on this, never on an engine or backend name.
   */
  transport?: HandsfreeCallTransport;
  /** Passed through to `voice.session.start` untouched when `transport` is gate. */
  voiceEngine?: string;
};

export type { HandsfreeStartAttempt, HandsfreeStartResult };

export type HandsfreeVoiceContextValue = {
  phase: HandsfreePhase;
  /** A call is live (not idle and not ended). */
  active: boolean;
  /**
   * Whether the call's microphone is muted right now. True from `muted`, and
   * also while a turn is still in flight after Mute was tapped: the words are
   * still owed, but the microphone is already off and the control has to say so.
   */
  muted: boolean;
  /**
   * The epoch (`Date.now()`) the live call started at, once the native side
   * confirmed `started`; undefined for an idle call or one whose start this
   * device never recorded. The surface folds it through
   * `handsfreeElapsedCopy` to say how long the call has been running.
   */
  startedAtMs: number | undefined;
  /** When the current wait on a turn began, or null when nothing is pending. */
  sendingSinceMs: number | null;
  /** The live transcript of the current turn, for the banner. */
  partial: string;
  /**
   * Why the last Gate turn died, in the Gate's own words, or null while no turn
   * has failed. The banner names it once and the call keeps going: the Gate
   * speaks its own failure line and reopens listening.
   */
  turnError: string | null;
  /** The last Gate turn state the Gate reported, or null before the first turn. */
  turnState: GateCallBanner['turnState'];
  label: string | undefined;
  reason: HandsfreeTerminalReason | undefined;
  lastEndReason?: HandsfreeTerminalReason;
  /** How many calls have finished, so the screen can react to a repeat failure. */
  callsEnded: number;
  /**
   * The latest 0–1 amplitude sample, a shared value so the Skia dot reads it on
   * the UI thread and no React render happens per sample. It stays 0 when the
   * platform supplies none.
   */
  level: SharedValue<number>;
  /** The engine a live call is using, once the Gate has answered. */
  engine?: string;
  /** Why the call is not on the preferred engine, when the Gate fell back. */
  engineReason?: string;
  /** Whether `start` can succeed right now. */
  canStart: boolean;
  /** What blocks a start right now, or null. */
  startBlocker: HandsfreeStartBlocker | null;
  start: (target: HandsfreeCallTarget) => Promise<HandsfreeStartAttempt>;
  mute: () => void;
  unmute: () => void;
  skipReply: () => void;
  end: () => void;
};

const HandsfreeVoiceContext = createContext<HandsfreeVoiceContextValue | null>(null);

function callDraftThread(target: HandsfreeCallTarget): ComposerDraftThread | undefined {
  return composerDraftThread({
    gatewayId: target.gatewayId,
    surface:
      target.surfaceKind === 'bot'
        ? { kind: 'bot', botId: target.botId ?? '' }
        : { kind: 'configurable' },
    sessionId: target.sessionId,
  });
}

function clampLevel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Cancels exactly the native start named by `startId`, fire-and-forget. A
 * synchronous throw or a rejected promise from the native call is swallowed:
 * the attempt is already abandoned on the JS side, and the caller must never
 * be stranded or leak an unhandled rejection because the cleanup failed.
 */
function cancelNativeSession(module: HandsfreeNativeModule, startId: string): void {
  cancelNativeStart((id) => module.stopSession({ startId: id }), startId);
}

/**
 * Only a dead media socket is worth re-opening: the Gate holds the call for
 * its resume window and re-attaches the same session. Every other fatal frame
 * (engine open failed, ended) names a call that is actually over.
 */
function isRetryableSocketFailure(frame: unknown): frame is string {
  if (typeof frame !== 'string') return false;
  const parsed = gateFrame(frame);
  return parsed?.t === 'error' && parsed.fatal && parsed.code === 'socket_failed';
}

/** The frame as the Gate sent it, or null when this build cannot read it. */
function gateFrame(frame: string): GateVoiceFrame | null {
  try {
    return parseGateFrame(frame);
  } catch {
    return null;
  }
}

/**
 * Whether a `phase` frame confirms the mute (or the unmute) this phone just
 * asked for. A phase frame produced BEFORE the Gate processed the control says
 * nothing about it, and one that does not reflect the request must leave the
 * rollback waiting: any phase frame used to end the wait, so a mute the Gate
 * never applied was never put back and the label disagreed with the Gate.
 */
function phaseConfirmsMute(phase: VoicePhase, requested: boolean): boolean {
  return requested ? phase === 'muted' : phase !== 'muted';
}

export function HandsfreeVoiceProvider({ children }: { children: React.ReactNode }) {
  const {
    activeGateway,
    status,
    currentSessionId,
    selectedBotId,
    pendingRunApproval,
    sendChatInput,
    gatewayRequest,
    reloadHistory,
  } = useGateway();
  const { messages, isSending, isCommandRunning } = useChatSurface();

  const [session, setSession] = useState<HandsfreeSessionState>(INITIAL_HANDSFREE_SESSION);
  // The amplitude sample moves at the platform's own rate (~10/s) and only the
  // banner's Skia dot reads it, so it lives in a shared value the circle reads on
  // the UI thread rather than in React state that redraws the banner per sample.
  const level = useSharedValue(0);
  const [availability, setAvailability] = useState<HandsfreeAvailability | null>(null);
  const [label, setLabel] = useState<string | undefined>(undefined);
  const [gateBanner, setGateBanner] = useState<GateCallBanner>(INITIAL_GATE_CALL);
  const [gateMode, setGateMode] = useState(false);
  const [engineInfo, setEngineInfo] = useState<{ engine: string; reason?: string } | null>(null);

  const sessionRef = useRef(session);
  const moduleRef = useRef<HandsfreeNativeModule | null>(null);
  const targetRef = useRef<HandsfreeCallTarget | null>(null);
  const threadRef = useRef<ComposerDraftThread | undefined>(undefined);
  const availabilityRef = useRef<HandsfreeAvailability | null>(null);
  const subscriptionsRef = useRef<{ remove(): void }[]>([]);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spokenRef = useRef('');
  // Where the last speech plan's sentence scan stopped, so the next streamed
  // delta plans from there instead of re-reading the whole reply.
  const speechCursorRef = useRef<HandsfreeSpeechCursor | undefined>(undefined);
  // One speak at a time per reply: the newest text is parked here while a speak
  // is in flight, and the retry timer for a refused one.
  const speakTextRef = useRef<{ fullText: string; streaming: boolean } | null>(null);
  const speakBusyRef = useRef(false);
  const speakRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped by every `resetSpeech`, so a speak that answers after a barge-in, a
  // Skip or an End cannot write its text into the plan the next turn starts from.
  const speakEpochRef = useRef(0);
  const fallbackRef = useRef(false);
  const turnIdRef = useRef<string | undefined>(undefined);
  const replyIdRef = useRef<string | undefined>(undefined);
  // The reply text the watchdog was last armed for, so a stream that keeps
  // producing words keeps the watch quiet and one that stops does not.
  const watchdogTextRef = useRef('');
  const endingRef = useRef(false);
  const runEffectRef = useRef<(effect: HandsfreeEffect) => void>(() => undefined);
  const teardownRef = useRef<() => Promise<void>>(async () => undefined);
  // Whether this call is driven by the Gate, and the session the Gate gave it.
  const gateModeRef = useRef(false);
  const gateSessionIdRef = useRef<string | undefined>(undefined);
  const gateBannerRef = useRef<GateCallBanner>(INITIAL_GATE_CALL);
  // The grant a live Gate call is joined with: the reconnect path re-opens the
  // media socket with these exact ids inside the Gate's resume window.
  const gateGrantRef = useRef<GateVoiceGrant | null>(null);
  const gateReconnectingRef = useRef(false);
  // An optimistic Gate mute, the mute it asked for, and the banner it replaced.
  // The Gate's own `phase` frame is the authority — but only one that REFLECTS
  // the request: until such a frame arrives (or refuses to) the fold is
  // unconfirmed, and a control frame that never lands must not leave the banner
  // claiming a microphone the Gate still has open.
  const gateMuteRef = useRef<{
    requested: boolean;
    previous: { phase: GateCallBanner['phase']; muted: boolean };
    timer: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  // The Gate's first frame on a media socket is the only proof the link is up:
  // `startGateMedia` resolves as soon as the socket was handed over, and its
  // boolean is not evidence. Held outside React — it is awaited by the start
  // chain and settled from socket callbacks.
  const gateLinkRef = useRef(createGateLinkProbe());

  // Everything a stable callback has to read at call time. Updated after every
  // render, so `start` and the reply watchers always see the current values
  // without being rebuilt (and without re-rendering every consumer).
  const latest = useRef({
    status,
    activeGateway,
    currentSessionId,
    selectedBotId,
    pendingRunApproval,
    messages,
    isSending,
    isCommandRunning,
    sendChatInput,
    availability,
    gatewayRequest,
    reloadHistory,
    label,
  });
  useEffect(() => {
    latest.current = {
      status,
      activeGateway,
      currentSessionId,
      selectedBotId,
      pendingRunApproval,
      messages,
      isSending,
      isCommandRunning,
      sendChatInput,
      availability,
      gatewayRequest,
      reloadHistory,
      label,
    };
  });

  // When the current wait on a turn began, so the banner can name a slow one.
  // Stamped here and in the Gate fold — both are event callbacks — because the
  // banner may neither read a ref nor set state from an effect during render.
  const [sendingSinceMs, setSendingSinceMs] = useState<number | null>(null);
  const noteWaiting = useCallback((waiting: boolean) => {
    setSendingSinceMs((current) => (waiting ? (current ?? Date.now()) : null));
  }, []);

  const dispatch = useCallback((event: HandsfreeEvent): HandsfreeSessionState => {
    const { state, effects } = reduceHandsfreeSession(sessionRef.current, event);
    sessionRef.current = state;
    setSession(state);
    noteWaiting(state.phase === 'sending');
    for (const effect of effects) runEffectRef.current(effect);
    return state;
  }, []);

  const clearGrace = useCallback(() => {
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
  }, []);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  /** An optimistic Gate mute stops waiting to be confirmed. */
  const clearGateMute = useCallback(() => {
    const pending = gateMuteRef.current;
    if (!pending) return;
    if (pending.timer !== null) clearTimeout(pending.timer);
    gateMuteRef.current = null;
  }, []);

  /**
   * Put the banner back the way the Gate last described the call. Used when the
   * control frame is refused or never confirmed: a banner that says "Muted"
   * while the Gate is still capturing is a lie the operator pays for. Only the
   * MUTE is put back — the Gate's latest phase is more current than the one
   * from before the tap, and rewinding it would report a phase that has moved on.
   */
  const rollbackGateMute = useCallback(
    (why: string) => {
      const pending = gateMuteRef.current;
      if (!pending) return;
      clearGateMute();
      const next: GateCallBanner = {
        ...gateBannerRef.current,
        phase: gateBannerRef.current.phase === 'muted' ? pending.previous.phase : gateBannerRef.current.phase,
        muted: pending.previous.muted,
      };
      gateBannerRef.current = next;
      setGateBanner(next);
      console.warn(
        `[gate-mute] ${why} session=${gateSessionIdRef.current ?? 'unknown'} phase=${next.phase}`,
      );
    },
    [clearGateMute],
  );

  /**
   * Fold the banner the way the operator was promised it — the moment is
   * immediate — and remember what the Gate last said, so the fold can be undone
   * when the Gate disagrees. A `phase` frame CONFIRMS it, and only one that
   * reflects this exact request; a refusal, or five seconds without such a
   * frame, does not.
   */
  const foldGateMute = useCallback(
    (muted: boolean) => {
      const previous = gateBannerRef.current;
      const next: GateCallBanner = {
        ...previous,
        phase: muted ? 'muted' : 'listening',
        muted,
      };
      gateBannerRef.current = next;
      setGateBanner(next);
      clearGateMute();
      gateMuteRef.current = {
        requested: muted,
        previous: { phase: previous.phase, muted: previous.muted },
        timer: setTimeout(() => rollbackGateMute('the Gate never confirmed the mute'), GATE_MUTE_CONFIRM_MS),
      };
      return moduleRef.current?.sendGateControl(
        serializeGateControl(gateControlFor(muted ? 'mute' : 'unmute')),
      );
    },
    [clearGateMute, rollbackGateMute],
  );

  const resetSpeech = useCallback(() => {
    spokenRef.current = '';
    speechCursorRef.current = undefined;
    fallbackRef.current = false;
    speakEpochRef.current += 1;
    // A retry belongs to one reply: a new turn, a stop or a teardown must not
    // inherit it, or a chunk refused for the previous reply is offered here.
    if (speakRetryTimerRef.current) {
      clearTimeout(speakRetryTimerRef.current);
      speakRetryTimerRef.current = null;
    }
    speakTextRef.current = null;
    speakBusyRef.current = false;
  }, []);

  const unsubscribe = useCallback(() => {
    for (const subscription of subscriptionsRef.current) subscription.remove();
    subscriptionsRef.current = [];
  }, []);

  const subscribe = useCallback(
    (module: HandsfreeNativeModule) => {
      unsubscribe();
      const onTranscript = (text: string) => {
        const next = dispatch({ type: 'partial', text });
        const thread = threadRef.current;
        const recover = next.partial || next.held;
        if (thread && recover) void saveHandsfreeRecovery(thread, recover);
      };
      const onFinal = (text: string) => {
        const next = dispatch({ type: 'final', text });
        const thread = threadRef.current;
        const recover = next.partial || next.held;
        if (thread && recover) void saveHandsfreeRecovery(thread, recover);
      };
      subscriptionsRef.current = [
        module.addListener('partial', (event) => onTranscript(event.text)),
        module.addListener('final', (event) => onFinal(event.text)),
        module.addListener('noSpeech', () => {
          dispatch({ type: 'noSpeech' });
        }),
        module.addListener('speechFinished', () => {
          dispatch({ type: 'speechFinished' });
        }),
        module.addListener('interruption', () => {
          dispatch({ type: 'interruption' });
        }),
        module.addListener('endRequested', (event) => {
          // The notification's End carries the operator's own reason; the
          // platform also ends a call nobody asked to end when its foreground
          // service dies under a live runtime, and that is a different fact the
          // screen can name rather than a call the operator walked away from.
          dispatch({
            type: 'endRequested',
            reason: event.reason === 'app-killed' ? 'app-killed' : undefined,
          });
        }),
        module.addListener('fatalError', (event) => {
          dispatch({ type: 'fatalError', reason: event.reason });
        }),
        module.addListener('bargeIn', () => {
          dispatch({ type: 'bargeIn' });
        }),
        // `level` is banner-only: it never reaches the reducer and nothing
        // depends on it, so a platform that omits it changes nothing. A sample is
        // a shared-value write on the UI thread, never a React render.
        module.addListener('level', (event) => {
          level.value = clampLevel(event.level);
        }),
      ];
    },
    [dispatch, level, unsubscribe],
  );

  // What a folded Gate effect means natively. `ended` is the Gate's terminal
  // word, so it takes the reducer's one terminal path rather than tearing down
  // here; a late frame cannot run this twice because the banner is terminal.
  const runGateEffect = useCallback((effect: GateCallEffect) => {
    if (effect.kind === 'send-control') {
      void moduleRef.current?.sendGateControl(serializeGateControl(effect.frame));
      return;
    }
    if (effect.kind === 'reload-history') {
      void latest.current.reloadHistory();
      return;
    }
    dispatch({ type: 'end' });
  }, [dispatch]);

  const subscribeGate = useCallback(
    (module: HandsfreeNativeModule) => {
      unsubscribe();
      // The Gate's spoken turn, kept the way the phone engine keeps it: a `final`
      // is persisted under this thread so a call that dies before the turn lands
      // hands the words back in the composer, and the `turn` frame that says the
      // turn started is what marks them delivered. A turn that FAILED is not a
      // delivery — the words are still owed.
      const noteGateTurn = (frame: GateVoiceFrame): void => {
        const thread = threadRef.current;
        if (!thread) return;
        if (frame.t === 'final') {
          void saveHandsfreeRecovery(thread, frame.text);
          return;
        }
        if (frame.t === 'turn' && frame.state !== 'failed') {
          void clearHandsfreeRecovery(thread);
        }
      };
      const fold = (frame: string) => {
        const parsed = gateFrame(frame);
        if (parsed) {
          noteGateTurn(parsed);
          // The Gate's own account of the phase settles an optimistic mute only
          // when it REFLECTS the request: a phase frame produced before the Gate
          // read the control proves nothing, and treating it as a confirmation
          // is what let an unapplied mute stand for the rest of the call.
          const pending = gateMuteRef.current;
          if (pending && parsed.t === 'phase' && phaseConfirmsMute(parsed.phase, pending.requested)) {
            clearGateMute();
          }
        }
        const next = reduceGateCall(gateBannerRef.current, frame);
        gateBannerRef.current = next.state;
        setGateBanner(next.state);
        noteWaiting(appPhaseForGate(next.state.phase) === 'sending');
        for (const gateEffect of next.effects) runGateEffect(gateEffect);
      };
      // A failed socket is the one failure the Gate plans for: it holds the
      // call open for its resume window and re-attaches a socket with the same
      // voiceSessionId. Spend that window re-opening the media socket — and count
      // an attempt as re-attached only once the Gate is proved to be on it —
      // instead of ending an otherwise healthy call.
      const attemptReconnect = async (frame: string) => {
        const grant = gateGrantRef.current;
        const gateway = latest.current.activeGateway;
        const rejoined = grant && gateway?.url
          ? await reconnectGateMedia({
              grant,
              gatewayUrl: gateway.url,
              gatewayToken: gateway.token ?? '',
              startGateMedia: (options) => moduleRef.current?.startGateMedia(options) ?? Promise.resolve(false),
              proveLink: (budgetMs) => gateLinkRef.current.prove(budgetMs),
              isAborted: () =>
                endingRef.current || !gateModeRef.current || gateGrantRef.current !== grant,
            })
          : false;
        gateReconnectingRef.current = false;
        if (rejoined) return;
        // The window ran out with no Gate on the link. That is the end of the
        // call, with its own reason: folding the socket frame would end it as
        // `user` and report a dropped link as the operator's own walk-away.
        if (isGateSocketGone(frame)) {
          dispatch({ type: 'linkLost' });
          return;
        }
        fold(frame);
      };
      subscriptionsRef.current = [
        module.addListener('gate', (event) => {
          // Every frame settles the link proof on its way past, including the
          // socket deaths: the Gate's first word on this link is what makes it
          // real, and its refusal is what makes it dead.
          gateLinkRef.current.observe(event.frame);
          if (isRetryableSocketFailure(event.frame)) {
            // A reconnect attempt that fails emits the same frame again; only
            // the first one starts a reconnect, the rest are swallowed.
            if (gateReconnectingRef.current || endingRef.current || !gateGrantRef.current) return;
            gateReconnectingRef.current = true;
            void attemptReconnect(event.frame);
            return;
          }
          fold(event.frame);
        }),
        // The amplitude sample is banner-only, exactly as on the phone engine.
        module.addListener('level', (event) => {
          level.value = clampLevel(event.level);
        }),
      ];
    },
    [clearGateMute, dispatch, level, runGateEffect, unsubscribe],
  );

  const teardown = useCallback(async () => {
    if (endingRef.current) return;
    if (sessionRef.current.phase === 'idle' || sessionRef.current.phase === 'ended') return;
    endingRef.current = true;
    clearGrace();
    clearWatchdog();
    clearGateMute();
    // A proof the call never finished proving settles nothing now: the link it
    // was waiting on is being closed underneath it.
    gateLinkRef.current.release();
    unsubscribe();
    const wasGate = gateModeRef.current;
    const gateSessionId = gateSessionIdRef.current;
    gateModeRef.current = false;
    setGateMode(false);
    gateSessionIdRef.current = undefined;
    gateGrantRef.current = null;
    gateReconnectingRef.current = false;
    setEngineInfo(null);
    const module = moduleRef.current;
    moduleRef.current = null;
    if (wasGate) {
      // The Gate owns capture, playback and the loop; the phone still owns the
      // foreground session we opened so the notification can end the call.
      try {
        await module?.stopGateMedia();
      } catch {
        // best-effort: a socket that will not close still stops locally
      }
      try {
        await module?.stopSession();
      } catch {
        // best-effort: the service's own teardown still runs
      }
      if (gateSessionId) {
        try {
          await latest.current.gatewayRequest('voice.session.stop', {
            voiceSessionId: gateSessionId,
            reason: 'user',
          });
        } catch {
          // the session's own idle close ends it if this never lands
        }
      }
    } else {
      endHandsfreeCall();
      try {
        await module?.stopSession();
      } catch {
        // best-effort: teardown continues so the JS state never stays mid-call
      }
      try {
        await stopSpeech();
      } catch {
        // a B2 queue that will not stop is not asked twice
      }
    }
    resetSpeech();
    turnIdRef.current = undefined;
    replyIdRef.current = undefined;
    const thread = threadRef.current;
    if (thread) {
      try {
        await promoteHandsfreeRecovery(thread);
      } catch {
        // recovery is best-effort; the call still ends
      }
    }
    dispatch({ type: 'stopped' });
  }, [clearGateMute, clearGrace, clearWatchdog, dispatch, resetSpeech, unsubscribe]);

  useEffect(() => {
    teardownRef.current = teardown;
  }, [teardown]);

  const armGrace = useCallback(() => {
    clearGrace();
    graceTimerRef.current = setTimeout(() => {
      graceTimerRef.current = null;
      dispatch({ type: 'grace-elapsed' });
    }, HANDSFREE_GRACE_MS);
  }, [clearGrace, dispatch]);

  const armWatchdog = useCallback(() => {
    clearWatchdog();
    watchdogRef.current = setTimeout(() => {
      watchdogRef.current = null;
      // A reply id already bound means the reply APPEARED and is still
      // streaming — the watchdog's contract is a reply nothing produced, so
      // this is the reply-failed reopen-not-die turn, not a dead call.
      dispatch(
        replyIdRef.current ? { type: 'reply-failed' } : { type: 'send-failed' },
      );
    }, HANDSFREE_REPLY_WATCHDOG_MS);
  }, [clearWatchdog, dispatch]);

  const streamReplyText = useCallback((fullText: string, streaming: boolean) => {
    // The newest text always wins: a reply streams faster than the speech queue
    // is drained, so what is spoken next is planned from what has arrived last.
    speakTextRef.current = { fullText, streaming };
    if (speakBusyRef.current) return;
    // The plan this run works against, retired by the next `resetSpeech`.
    const epoch = speakEpochRef.current;

    /**
     * One speak at a time, planned from the newest text and from what the
     * platform has actually accepted. A refused chunk is offered again a bounded
     * number of times and is never recorded as spoken; when the retries run out
     * the call reopens the microphone for the next turn instead of parking on
     * "Speaking" with a reply nobody ever heard.
     */
    const offer = (
      text: { fullText: string; streaming: boolean },
      retriesLeft: number,
      refusedAs: string | null,
    ): void => {
      // A retry belongs to one reply: a barge-in, a Skip or an End that reset
      // the plan retired this offer, and a new turn's plan must not inherit it.
      // `resetSpeech` already released the claim, and releasing it again here
      // would hand a second speak to a reply that is already being spoken.
      if (speakEpochRef.current !== epoch) return;
      // Claimed until this offer parks or finishes: a delta arriving mid-speak
      // leaves its text in `speakTextRef` rather than starting a second one.
      speakBusyRef.current = true;
      if (refusedAs !== null) {
        if (retriesLeft <= 0) {
          speakBusyRef.current = false;
          void recordFailure({
            kind: 'other',
            message: `A hands-free reply was never spoken: the platform refused it (${refusedAs}).`,
          });
          dispatch({ type: 'reply-failed' });
          return;
        }
        speakRetryTimerRef.current = setTimeout(() => {
          speakRetryTimerRef.current = null;
          offer(text, retriesLeft - 1, null);
        }, HANDSFREE_SPEAK_RETRY_MS);
        return;
      }

      const module = moduleRef.current;
      const bound = availabilityRef.current?.maxSpeechInputLength ?? 0;
      if (!module || !(bound > 0)) {
        speakBusyRef.current = false;
        return;
      }
      const plan = planHandsfreeSpeech({
        fullText: text.fullText,
        streaming: text.streaming,
        spoken: spokenRef.current,
        maxLength: bound,
        waitForCompletion: fallbackRef.current,
        cursor: speechCursorRef.current,
      });
      speechCursorRef.current = plan.cursor;
      if (plan.mutated) {
        // A reply that mutated where it was already spoken is no longer trusted
        // to be append-only; this turn waits for completion, the next resumes.
        fallbackRef.current = true;
        spokenRef.current = '';
        speakBusyRef.current = false;
        return;
      }
      if (!plan.chunks.length) {
        speakBusyRef.current = false;
        return;
      }
      const voice = targetRef.current?.voice ?? {};
      void Promise.resolve(module.speak({ chunks: plan.chunks, ...voice })).then(
        (accepted) => {
          if (!accepted) {
            offer(text, retriesLeft, 'it answered false');
            return;
          }
          // Only text the platform took is spoken text — and only while this is
          // still the reply being spoken: a barge-in, a Skip or an End that
          // reset the plan must not be undone by a speak already in the air,
          // and this late answer must not release the next reply's own claim
          // on the single speak slot either.
          if (speakEpochRef.current !== epoch) return;
          spokenRef.current = plan.spoken;
          // The parked text is a fresh object every run, so identity would report
          // a delta that never arrived; what is worth another pass is a delta
          // that changed the text or stopped the stream.
          const newest = speakTextRef.current;
          if (newest && (newest.fullText !== text.fullText || newest.streaming !== text.streaming)) {
            offer(newest, HANDSFREE_SPEAK_RETRY_LIMIT, null);
            return;
          }
          speakBusyRef.current = false;
        },
        (error: unknown) => {
          offer(text, retriesLeft, error instanceof Error ? error.message : String(error));
        },
      );
    };

    offer({ fullText, streaming }, HANDSFREE_SPEAK_RETRY_LIMIT, null);
  }, [dispatch]);

  const performSend = useCallback(
    async (text: string) => {
      const target = targetRef.current;
      const id = createMessageId('voice-call');
      turnIdRef.current = id;
      replyIdRef.current = undefined;
      resetSpeech();
      const thread = threadRef.current;
      if (thread) await saveHandsfreeRecovery(thread, text);
      // The watchdog is armed BEFORE awaiting: for plain text `sendChatInput`
      // resolves only after the reply finishes streaming, so arming on the
      // resolution would watch a turn that is already over. It is cleared when
      // speaking starts and on teardown.
      armWatchdog();
      const outcome = await latest.current.sendChatInput(text, {
        source: 'handsfree-call',
        messageId: id,
        sessionId: target?.sessionId || undefined,
        botId: target?.botId,
      });
      // A resolution for a turn the call has already left is a confirmation
      // only; it must not arm a watchdog or end a later turn.
      if (turnIdRef.current !== id) return;
      if (outcome === 'sent') {
        // The words are now an accepted turn; recovery is cleared only here.
        if (thread) void clearHandsfreeRecovery(thread);
        return;
      }
      // A failure only ends the call while the turn is still awaiting a reply.
      const phase = sessionRef.current.phase;
      if (phase === 'sending' || phase === 'waiting') {
        dispatch(
          outcome === 'busy'
            ? { type: 'send-busy' }
            : outcome === 'offline'
              ? { type: 'send-offline' }
              : { type: 'send-failed' },
        );
      }
    },
    [armWatchdog, dispatch, resetSpeech],
  );

  // The native service may still be starting when the reducer first asks it to
  // listen; a `false` is "not yet", not silence to ignore. Only a listen that
  // never starts ends the call, with a reason the screen can name.
  const startListeningWithRetry = useCallback(async () => {
    for (let attempt = 0; attempt < HANDSFREE_LISTEN_RETRY_LIMIT; attempt += 1) {
      const module = moduleRef.current;
      const phase = sessionRef.current.phase;
      if (!module || (phase !== 'listening' && phase !== 'confirming')) return;
      if (await module.startListening()) return;
      await new Promise((resolve) => setTimeout(resolve, HANDSFREE_LISTEN_RETRY_MS));
    }
    dispatch({ type: 'fatalError', reason: 'recognition-failed' });
  }, [dispatch]);

  const runEffect = (effect: HandsfreeEffect) => {
    if (gateModeRef.current) {
      // The Gate owns the loop: listening, the grace window, speech and sends
      // are its decisions, not the phone engine's. Only the terminal effect is
      // the provider's to run, and `runGateEffect` handles the rest.
      if (effect.kind === 'stop-session') void teardown();
      return;
    }
    const module = moduleRef.current;
    switch (effect.kind) {
      case 'start-listening':
        void startListeningWithRetry();
        return;
      case 'stop-listening':
        void module?.stopListening();
        return;
      case 'set-muted':
        void module?.setMuted(effect.muted);
        return;
      case 'play-earcon':
        void module?.playSendEarcon();
        return;
      case 'stop-speaking':
        void module?.stopSpeaking();
        resetSpeech();
        return;
      case 'arm-grace':
        armGrace();
        return;
      case 'cancel-grace':
        clearGrace();
        return;
      case 'send-turn':
        void performSend(effect.text);
        return;
      case 'speak-reply':
        resetSpeech();
        clearWatchdog();
        return;
      case 'stop-session':
        void teardown();
        return;
    }
  };
  useEffect(() => {
    runEffectRef.current = runEffect;
  });

  // The correlated reply, and progressive speech, once per transcript change.
  useEffect(() => {
    const phase = session.phase;
    if (phase !== 'sending' && phase !== 'waiting' && phase !== 'speaking') return;
    const turnId = turnIdRef.current;
    if (!turnId) return;
    const reply = handsfreeReplyForTurn(messages, turnId);
    if (!reply) return;
    if (isFailedReply(reply)) {
      dispatch({ type: 'reply-failed' });
      return;
    }
    if (phase === 'sending') {
      if (replyIdRef.current === reply.id) return;
      replyIdRef.current = reply.id;
      // A reply that appeared proves the turn left; the reply row is on screen
      // even while it streams for longer than the watchdog, so the watchdog's
      // contract (a reply nothing produced) is discharged HERE, not at the
      // first word spoken. A later watchdog fire while the id is bound is the
      // reply-failed reopen arm, not a dead call.
      clearWatchdog();
      dispatch({ type: 'reply-appeared' });
      return;
    }
    if (replyIdRef.current && reply.id !== replyIdRef.current) return;
    // The reply-appeared edge above discharged the watchdog, and that is only
    // honest while the reply is actually producing. A row that arrived with no
    // words in it, or one that stopped streaming, still owes text: it is armed
    // again for as long as it is silent, so an empty or stalled reply reopens
    // the microphone instead of parking the call in Waiting with the mic shut.
    // The streaming flag is part of the key: a reply that FINISHED streaming is a
    // whole answer now, and the phone is only reading it aloud, which for a long
    // answer outlasts the watchdog. Only a reply that is still streaming (and
    // might have stalled) or has no words in it is watched.
    const spokenFor = `${reply.id}:${reply.streaming ? 1 : 0}:${reply.text}`;
    if (replyIdRef.current && watchdogTextRef.current !== spokenFor) {
      watchdogTextRef.current = spokenFor;
      if (reply.streaming || !reply.text.trim()) armWatchdog();
      else clearWatchdog();
    }
    if (phase === 'waiting') {
      if (reply.text.trim()) dispatch({ type: 'reply-content' });
      return;
    }
    streamReplyText(reply.text, Boolean(reply.streaming));
  }, [messages, session.phase, armWatchdog, dispatch, streamReplyText, clearWatchdog]);

  // Read the device's call capability while connected, so the Call control is
  // only offered where a tap can actually start a session.
  useEffect(() => {
    if (status !== 'connected') return undefined;
    let cancelled = false;
    const probe = async () => {
      for (let attempt = 0; attempt < HANDSFREE_PROBE_RETRIES; attempt += 1) {
        const module = await loadHandsfreeModule();
        if (cancelled || !module) return;
        try {
          const read = await module.getAvailability();
          if (cancelled) return;
          setAvailability(read);
          if (read.recognition) return;
        } catch {
          if (!cancelled) setAvailability(null);
        }
        await new Promise((resolve) => setTimeout(resolve, HANDSFREE_PROBE_RETRY_MS));
      }
    };
    void probe();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void probe();
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [status]);

  // A call is bound to the gateway, session and Bot it captured: any of them
  // moving ends it before another utterance can be sent into the wrong thread.
  useEffect(() => {
    const phase = session.phase;
    if (phase !== 'sending' && phase !== 'waiting' && phase !== 'speaking' && phase !== 'listening' && phase !== 'confirming' && phase !== 'muted' && phase !== 'starting') return;
    const target = targetRef.current;
    if (!target) return;
    const diverged =
      activeGateway?.id !== target.gatewayId ||
      (currentSessionId ?? '') !== (target.sessionId ?? '') ||
      (selectedBotId ?? undefined) !== (target.botId ?? undefined);
    if (diverged) dispatch({ type: 'thread-changed' });
  }, [activeGateway?.id, currentSessionId, selectedBotId, session.phase, dispatch]);

  // The connection is the call's lifeline; losing it ends the call rather than
  // parking speech in the offline outbox.
  useEffect(() => {
    const phase = session.phase;
    if (phase === 'idle' || phase === 'ended' || phase === 'ending') return;
    if (status !== 'connected') dispatch({ type: 'disconnect' });
  }, [status, session.phase, dispatch]);

  // Unmounting the provider (app teardown) releases the call exactly as End does.
  useEffect(() => {
    return () => {
      void teardownRef.current();
      // A refused chunk's retry must not outlive the provider that owned it: a
      // teardown that found the call already idle returns early, and the timer
      // would still fire into a phone that has no call.
      if (speakRetryTimerRef.current) {
        clearTimeout(speakRetryTimerRef.current);
        speakRetryTimerRef.current = null;
      }
      clearGateMute();
    };
  }, [clearGateMute]);

  // Detach every listener and ref a Gate start captured, without telling the
  // reducer the start was refused. An abandoned start that ran out of budget is
  // its own fact — `start-timeout` — and a `start-refused` first would move the
  // reducer out of `starting` and make the timeout event inert.
  const abandonGateStart = useCallback(() => {
    unsubscribe();
    clearGateMute();
    gateLinkRef.current.release();
    gateModeRef.current = false;
    setGateMode(false);
    setEngineInfo(null);
    gateSessionIdRef.current = undefined;
    gateGrantRef.current = null;
    gateReconnectingRef.current = false;
    moduleRef.current = null;
    targetRef.current = null;
    threadRef.current = undefined;
  }, [clearGateMute, unsubscribe]);

  const refuseGateStart = useCallback(() => {
    abandonGateStart();
    dispatch({ type: 'start-refused' });
  }, [abandonGateStart, dispatch]);

  // A Gate-powered call: grant the session, take the microphone, open the
  // media socket. Failures are named and a granted session is released so the
  // next start is not `call_in_progress`.
  const startGateCall = useCallback(
    async (
      target: HandsfreeCallTarget,
      module: HandsfreeNativeModule,
      read: HandsfreeAvailability | null,
    ): Promise<HandsfreeStartAttempt> => {
      const gateway = latest.current.activeGateway;
      if (!gateway?.url) {
        logHandsfreeStart({ result: 'no-gateway-url', transport: 'gate', engine: target.voiceEngine });
        return { result: 'no-gateway-url' };
      }

      moduleRef.current = module;
      if (read) {
        availabilityRef.current = read;
        setAvailability(read);
      }
      targetRef.current = target;
      threadRef.current = callDraftThread(target);
      setLabel(target.label);
      endingRef.current = false;
      gateModeRef.current = true;
      setGateMode(true);
      gateSessionIdRef.current = undefined;
      gateGrantRef.current = null;
      gateReconnectingRef.current = false;
      gateBannerRef.current = INITIAL_GATE_CALL;
      setGateBanner(INITIAL_GATE_CALL);

      subscribeGate(module);
      sessionRef.current = dispatch({ type: 'start' });

      // The whole Gate start runs under ONE budget. The device identity is read
      // after the phase has already moved to `starting`, so a secure-store call
      // that never answers would strand the start exactly the way a silent Gate
      // would; the grant, the microphone prompt, the media link and the release
      // are all links of the same chain. A second budget here would let the
      // sheet sit on "Starting" for twice the time every constant advertises. An
      // expiry is reported as its own reason: a refusal means a precondition the
      // sheet should have blocked, which is a different fact from a link that
      // went quiet.
      const budget = startDeadline();
      let device: { deviceId: string };
      try {
        device = await budget.guard('the device identity', pushDeviceParams());
      } catch (err) {
        budget.dispose();
        if (isStartTimeout(err)) {
          // Reset the captured refs and listeners without a refusal: this start
          // ran out of budget, which the reducer answers with its own event.
          abandonGateStart();
          logHandsfreeStart({
            result: 'start-timed-out',
            transport: 'gate',
            engine: target.voiceEngine,
            detail: err.message,
          });
          dispatch({ type: 'start-timeout' });
          return { result: 'start-timed-out', detail: err.message };
        }
        refuseGateStart();
        const result = isDeviceIdentityError(err) ? 'identity-unavailable' : 'device-params-failed';
        logHandsfreeStart({ result, transport: 'gate', engine: target.voiceEngine });
        return { result };
      }

      // The budget is disposed from a `finally`, not after the await: a chain that
      // rethrows would leave its timer pending, and a timer nobody disposed
      // rejects a promise no one is racing any more.
      const attempt = await openGateVoiceSession({
        gatewayUrl: gateway.url,
        gatewayToken: gateway.token ?? '',
        target: {
          label: target.label,
          voiceEngine: target.voiceEngine,
          surfaceKind: target.surfaceKind,
          sessionId: target.sessionId,
          botId: target.botId,
        },
        device,
        // The same one-shot budget, so the identity read and the whole chain
        // behind it are bounded together.
        deadline: budget,
        gatewayRequest: (method, params) => latest.current.gatewayRequest(method, params),
        startSession: (title, startId) => module.startSession({ title, startId }),
        // Keyed by the attempt's own id: this cleanup can never stop a newer
        // retry's session, and a sync throw or rejection is swallowed so it
        // cannot strand the start or leak an unhandled rejection.
        cancelStartSession: (startId) => cancelNativeSession(module, startId),
        startGateMedia: (options) => module.startGateMedia(options),
        // The native boolean only says the socket was handed to the network
        // stack. This is what makes the start honest: it waits for the Gate's
        // first frame on that socket, so a link that never comes up fails the
        // start instead of reporting a call that can hear nothing.
        proveLink: (budgetMs) => gateLinkRef.current.prove(budgetMs),
      }).finally(() => budget.dispose());

      if (attempt.result === 'start-timed-out') {
        // The chain inside `openGateVoiceSession` reports the expiry of the one
        // budget this start shares with it; this is the one expiry the provider
        // can still see, and it must reach the reducer as the event that returns
        // the call to idle. The inner chain already logged the timeout with the
        // link that went quiet — logging it again here would be a second, less
        // accurate line for one fact.
        abandonGateStart();
        dispatch({ type: 'start-timeout' });
        return { result: 'start-timed-out', detail: attempt.detail };
      }

      if (attempt.result !== 'started' || !attempt.grant) {
        refuseGateStart();
        return { result: attempt.result, detail: attempt.detail };
      }

      gateSessionIdRef.current = attempt.grant.voiceSessionId;
      gateGrantRef.current = attempt.grant;
      setEngineInfo({
        engine: attempt.grant.engine ?? 'local',
        ...(attempt.grant.fellBackFrom ? { reason: attempt.grant.reason } : {}),
      });

      if (sessionRef.current.phase !== 'starting') {
        refuseGateStart();
        try {
          await latest.current.gatewayRequest('voice.session.stop', {
            voiceSessionId: attempt.grant.voiceSessionId,
            reason: 'start-failed',
          });
        } catch {
          // the session's own idle close ends it if this never lands
        }
        logHandsfreeStart({ result: 'call-torn-down-while-starting', transport: 'gate' });
        return { result: 'call-torn-down-while-starting' };
      }
      dispatch({ type: 'started', startedAtMs: Date.now() });
      return { result: 'started' };
    },
    [abandonGateStart, dispatch, refuseGateStart, subscribeGate],
  );

  const start = useCallback(
    async (target: HandsfreeCallTarget): Promise<HandsfreeStartAttempt> => {
      const transport = target.transport === 'gate' ? 'gate' : 'phone';
      const snapshot = latest.current;

      const module = await loadHandsfreeModule();
      let read: HandsfreeAvailability | null = null;
      let availabilityError = false;
      if (module) {
        try {
          read = await module.getAvailability();
        } catch {
          availabilityError = true;
        }
      }

      const decision = evaluateHandsfreeStart({
        phase: sessionRef.current.phase,
        appState: AppState.currentState,
        status: snapshot.status,
        gatewayId: snapshot.activeGateway?.id,
        targetGatewayId: target.gatewayId,
        isSending: snapshot.isSending,
        isCommandRunning: snapshot.isCommandRunning,
        pendingRunApproval: Boolean(snapshot.pendingRunApproval),
        moduleLoaded: Boolean(module),
        availability: read,
        availabilityError,
        transport,
        gatewayUrl: snapshot.activeGateway?.url,
        sessionId: target.sessionId,
      });
      if (decision.kind === 'stop') {
        logHandsfreeStart({
          result: decision.result,
          transport,
          engine: target.voiceEngine,
          detail: decision.detail,
        });
        return { result: decision.result, detail: decision.detail };
      }
      if (!module) {
        logHandsfreeStart({ result: 'no-native-module', transport, engine: target.voiceEngine });
        return { result: 'no-native-module' };
      }
      if (decision.kind === 'gate') {
        return startGateCall(target, module, read);
      }
      if (!read) {
        logHandsfreeStart({ result: 'availability-unreadable', transport: 'phone' });
        return { result: 'availability-unreadable' };
      }

      moduleRef.current = module;
      availabilityRef.current = read;
      setAvailability(read);
      targetRef.current = target;
      threadRef.current = callDraftThread(target);
      setLabel(target.label);
      endingRef.current = false;

      // Listen first: a fatalError or interruption the native side emits while
      // the session is opening must reach the reducer, not vanish.
      subscribe(module);
      // The assignment re-reads the ref so TypeScript does not keep the `idle`
      // narrowing from the precondition above across the awaited native start.
      sessionRef.current = dispatch({ type: 'start' });
      // The native start is the OS prompt the deadline module names explicitly:
      // an answer that never comes used to leave the phase at `starting` for
      // the life of the process, and the only way back to `idle` — the phase
      // Call is offered from — is the `start-timeout` event below.
      const deadline = startDeadline();
      // This attempt's native key, so the timeout cleanup below cancels exactly
      // this start and cannot reach the service a newer retry owns.
      const startId = newHandsfreeStartId();
      let outcome: HandsfreeStartOutcome;
      try {
        outcome = await deadline.guard(
          'the microphone prompt',
          module.startSession({ title: target.label, startId }),
        );
      } catch (err) {
        deadline.dispose();
        if (isStartTimeout(err)) {
          unsubscribe();
          moduleRef.current = null;
          targetRef.current = null;
          threadRef.current = undefined;
          // Abandoning the JS side does not cancel the native start: it may
          // still be waiting on the OS microphone dialog, and a late grant
          // would open the microphone during the retry this timeout invites.
          // Cancelling names only this abandoned attempt's id, so a newer retry
          // that already owns the native side is untouched; a failed cancel is
          // swallowed so it cannot strand the start or leak a rejection.
          cancelNativeSession(module, startId);
          logHandsfreeStart({ result: 'start-timed-out', transport: 'phone', detail: err.message });
          dispatch({ type: 'start-timeout' });
          return { result: 'start-timed-out', detail: err.message };
        }
        outcome = 'unavailable';
      }
      deadline.dispose();
      if (outcome !== 'started') {
        unsubscribe();
        moduleRef.current = null;
        targetRef.current = null;
        threadRef.current = undefined;
        dispatch({ type: 'start-refused' });
        const result = outcome === 'permission-denied' ? 'permission-denied' : 'native-session-unavailable';
        logHandsfreeStart({ result, transport: 'phone' });
        return { result };
      }
      if (sessionRef.current.phase !== 'starting') {
        // A fatal event arrived while the session was opening and has already
        // torn it down; reporting "started" would contradict the screen.
        logHandsfreeStart({ result: 'call-torn-down-while-starting', transport: 'phone' });
        return { result: 'call-torn-down-while-starting' };
      }
      beginHandsfreeCall();
      setEngineInfo({ engine: 'phone' });
      dispatch({ type: 'started', startedAtMs: Date.now() });
      logHandsfreeStart({ result: 'started', transport: 'phone', engine: 'phone' });
      return { result: 'started' };
    },
    [dispatch, startGateCall, subscribe, unsubscribe],
  );

  const mute = useCallback(() => {
    if (gateModeRef.current) {
      // The banner folds now, but it is a promise until the Gate says so: a
      // refused or unconfirmed control frame puts the previous phase back.
      void Promise.resolve(foldGateMute(true)).then(
        (sent) => {
          if (sent === false) rollbackGateMute('the Gate refused the mute');
        },
        () => rollbackGateMute('the mute could not be sent'),
      );
      return;
    }
    dispatch({ type: 'mute' });
  }, [dispatch, foldGateMute, rollbackGateMute]);
  const unmute = useCallback(() => {
    if (gateModeRef.current) {
      void Promise.resolve(foldGateMute(false)).then(
        (sent) => {
          if (sent === false) rollbackGateMute('the Gate refused the unmute');
        },
        () => rollbackGateMute('the unmute could not be sent'),
      );
      return;
    }
    dispatch({ type: 'unmute' });
  }, [dispatch, foldGateMute, rollbackGateMute]);
  const skipReply = useCallback(() => {
    if (gateModeRef.current) {
      void moduleRef.current?.sendGateControl(serializeGateControl(gateControlFor('skip')));
      return;
    }
    dispatch({ type: 'skipReply' });
  }, [dispatch]);
  const end = useCallback(() => {
    if (gateModeRef.current) {
      void moduleRef.current?.sendGateControl(serializeGateControl(gateControlFor('end')));
    }
    dispatch({ type: 'end' });
  }, [dispatch]);

  // While the Gate drives the call, the banner phase and transcript come from
  // its frames; the phone reducer still owns the call's lifecycle (idle,
  // starting, ending), so teardown, thread-change and disconnect behave alike.
  const gateLive =
    gateMode &&
    session.phase !== 'idle' &&
    session.phase !== 'ending' &&
    session.phase !== 'ended';
  const active = session.phase !== 'idle' && session.phase !== 'ended';
  const phase = gateLive ? appPhaseForGate(gateBanner.phase) : session.phase;
  // The control's label follows the real state. A mute tapped while a turn was
  // still in flight has already muted the microphone, so the banner says so
  // before the phase itself reaches `muted`.
  const muted = phase === 'muted' || (!gateLive && session.muteIntent === true);
  const partial = gateLive ? gateBanner.partial : session.partial;
  // Offered whenever a call could run on this device; what blocks it *right now*
  // is reported separately so the control never flickers with chat activity.
  const canStart =
    session.phase === 'idle' &&
    status === 'connected' &&
    Boolean(activeGateway) &&
    handsfreeDeviceCanOfferCall(availability);

  const value: HandsfreeVoiceContextValue = {
    phase,
    active,
    muted,
    startedAtMs: session.startedAtMs,
    sendingSinceMs,
    partial,
    // The Gate's own account of the turn. Both are call-scoped: outside a live
    // Gate call there is no turn to report, and the banner draws nothing.
    turnError: gateLive ? gateBanner.turnError : null,
    turnState: gateLive ? gateBanner.turnState : null,
    label,
    reason: session.reason,
    lastEndReason: session.lastEndReason,
    callsEnded: session.callsEnded,
    level,
    engine: engineInfo?.engine,
    engineReason: engineInfo?.reason,
    canStart,
    startBlocker: handsfreeStartBlocker({
      status,
      isSending,
      isCommandRunning,
      pendingApproval: Boolean(pendingRunApproval),
    }),
    start,
    mute,
    unmute,
    skipReply,
    end,
  };

  return <HandsfreeVoiceContext.Provider value={value}>{children}</HandsfreeVoiceContext.Provider>;
}

export function useHandsfreeVoice(): HandsfreeVoiceContextValue {
  const context = useContext(HandsfreeVoiceContext);
  if (!context) throw new Error('useHandsfreeVoice must be used within HandsfreeVoiceProvider');
  return context;
}
