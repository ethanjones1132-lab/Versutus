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
import { isDeviceIdentityError } from '@/lib/gateway/errors';
import { pushDeviceParams } from '@/lib/notifications/push-registration';
import { reconnectGateMedia } from '@/lib/voice/gate-reconnect';
import { loadHandsfreeModule, type HandsfreeNativeModule } from '@/lib/voice/handsfree-device';
import { openGateVoiceSession } from '@/lib/voice/handsfree-start-attempt';
import {
  evaluateHandsfreeStart,
  handsfreeDeviceCanOfferCall,
  logHandsfreeStart,
  type GateVoiceGrant,
  type HandsfreeStartAttempt,
  type HandsfreeStartResult,
} from '@/lib/voice/handsfree-start-reason';
import { parseGateFrame } from '@/lib/voice/voice-stream-protocol';
import {
  handsfreeReplyForTurn,
  isFailedReply,
  planHandsfreeSpeech,
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
   * The epoch (`Date.now()`) the live call started at, once the native side
   * confirmed `started`; undefined for an idle call or one whose start this
   * device never recorded. The surface folds it through
   * `handsfreeElapsedCopy` to say how long the call has been running.
   */
  startedAtMs: number | undefined;
  /** The live transcript of the current turn, for the banner. */
  partial: string;
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
 * Only a dead media socket is worth re-opening: the Gate holds the call for
 * its resume window and re-attaches the same session. Every other fatal frame
 * (engine open failed, ended) names a call that is actually over.
 */
function isRetryableSocketFailure(frame: unknown): frame is string {
  if (typeof frame !== 'string') return false;
  try {
    const parsed = parseGateFrame(frame);
    return parsed.t === 'error' && parsed.fatal && parsed.code === 'socket_failed';
  } catch {
    return false;
  }
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
  const fallbackRef = useRef(false);
  const turnIdRef = useRef<string | undefined>(undefined);
  const replyIdRef = useRef<string | undefined>(undefined);
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

  const dispatch = useCallback((event: HandsfreeEvent): HandsfreeSessionState => {
    const { state, effects } = reduceHandsfreeSession(sessionRef.current, event);
    sessionRef.current = state;
    setSession(state);
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

  const resetSpeech = useCallback(() => {
    spokenRef.current = '';
    fallbackRef.current = false;
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
        module.addListener('endRequested', () => {
          dispatch({ type: 'endRequested' });
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
      const fold = (frame: string) => {
        const next = reduceGateCall(gateBannerRef.current, frame);
        gateBannerRef.current = next.state;
        setGateBanner(next.state);
        for (const gateEffect of next.effects) runGateEffect(gateEffect);
      };
      // A failed socket is the one failure the Gate plans for: it holds the
      // call open for its resume window and re-attaches a socket with the same
      // voiceSessionId. Spend that window re-opening the media socket instead
      // of ending an otherwise healthy call; only when the window runs out (or
      // the call ended by another path) does the fatal frame fold normally.
      const attemptReconnect = async (frame: string) => {
        const grant = gateGrantRef.current;
        const gateway = latest.current.activeGateway;
        const rejoined = grant && gateway?.url
          ? await reconnectGateMedia({
              grant,
              gatewayUrl: gateway.url,
              gatewayToken: gateway.token ?? '',
              startGateMedia: (options) => moduleRef.current?.startGateMedia(options) ?? Promise.resolve(false),
              isAborted: () =>
                endingRef.current || !gateModeRef.current || gateGrantRef.current !== grant,
            })
          : false;
        gateReconnectingRef.current = false;
        if (!rejoined) fold(frame);
      };
      subscriptionsRef.current = [
        module.addListener('gate', (event) => {
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
    [level, runGateEffect, unsubscribe],
  );

  const teardown = useCallback(async () => {
    if (endingRef.current) return;
    if (sessionRef.current.phase === 'idle' || sessionRef.current.phase === 'ended') return;
    endingRef.current = true;
    clearGrace();
    clearWatchdog();
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
  }, [clearGrace, clearWatchdog, dispatch, resetSpeech, unsubscribe]);

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
    const module = moduleRef.current;
    const bound = availabilityRef.current?.maxSpeechInputLength ?? 0;
    if (!module || !(bound > 0)) return;
    const plan = planHandsfreeSpeech({
      fullText,
      streaming,
      spoken: spokenRef.current,
      maxLength: bound,
      waitForCompletion: fallbackRef.current,
    });
    if (plan.mutated) {
      // A reply that mutated where it was already spoken is no longer trusted
      // to be append-only; this turn waits for completion, the next resumes.
      fallbackRef.current = true;
      spokenRef.current = '';
      return;
    }
    spokenRef.current = plan.spoken;
    if (!plan.chunks.length) return;
    const voice = targetRef.current?.voice ?? {};
    void module.speak({ chunks: plan.chunks, ...voice });
  }, []);

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
    if (phase === 'waiting') {
      if (reply.text.trim()) dispatch({ type: 'reply-content' });
      return;
    }
    streamReplyText(reply.text, Boolean(reply.streaming));
  }, [messages, session.phase, dispatch, streamReplyText, clearWatchdog]);

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
    };
  }, []);

  const refuseGateStart = useCallback(() => {
    unsubscribe();
    gateModeRef.current = false;
    setGateMode(false);
    setEngineInfo(null);
    gateSessionIdRef.current = undefined;
    gateGrantRef.current = null;
    gateReconnectingRef.current = false;
    moduleRef.current = null;
    targetRef.current = null;
    threadRef.current = undefined;
    dispatch({ type: 'start-refused' });
  }, [dispatch, unsubscribe]);

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

      let device: { deviceId: string };
      try {
        device = await pushDeviceParams();
      } catch (err) {
        refuseGateStart();
        const result = isDeviceIdentityError(err) ? 'identity-unavailable' : 'device-params-failed';
        logHandsfreeStart({ result, transport: 'gate', engine: target.voiceEngine });
        return { result };
      }

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
        gatewayRequest: (method, params) => latest.current.gatewayRequest(method, params),
        startSession: (title) => module.startSession({ title }),
        startGateMedia: (options) => module.startGateMedia(options),
      });

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
    [dispatch, refuseGateStart, subscribeGate],
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
      let outcome: HandsfreeStartOutcome;
      try {
        outcome = await module.startSession({ title: target.label });
      } catch {
        outcome = 'unavailable';
      }
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
      void moduleRef.current?.sendGateControl(serializeGateControl(gateControlFor('mute')));
      const next = { ...gateBannerRef.current, phase: 'muted' as const, muted: true };
      gateBannerRef.current = next;
      setGateBanner(next);
      return;
    }
    dispatch({ type: 'mute' });
  }, [dispatch]);
  const unmute = useCallback(() => {
    if (gateModeRef.current) {
      void moduleRef.current?.sendGateControl(serializeGateControl(gateControlFor('unmute')));
      const next = { ...gateBannerRef.current, phase: 'listening' as const, muted: false };
      gateBannerRef.current = next;
      setGateBanner(next);
      return;
    }
    dispatch({ type: 'unmute' });
  }, [dispatch]);
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
    startedAtMs: session.startedAtMs,
    partial,
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
