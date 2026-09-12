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

import { useChatSurface, useGateway } from '@/context/gateway-provider';
import { composerDraftThread, type ComposerDraftThread } from '@/lib/gateway/composer-draft';
import { createMessageId } from '@/lib/gateway/messages';
import { loadHandsfreeModule, type HandsfreeNativeModule } from '@/lib/voice/handsfree-device';
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
import { beginHandsfreeCall, endHandsfreeCall, stopSpeech } from '@/lib/voice/speech';
import type { HandsfreeAvailability, HandsfreeStartOutcome } from '../../modules/handsfree-voice';

/** How long a silence-triggered final is held before it sends. */
export const HANDSFREE_GRACE_MS = 600;

/** How long a sent turn may wait for its reply before the call fails. */
export const HANDSFREE_REPLY_WATCHDOG_MS = 120_000;

/** What one call is for. Built by the caller, never derived from context. */
export type HandsfreeCallTarget = {
  gatewayId: string;
  sessionId: string;
  surfaceKind: 'configurable' | 'bot';
  botId?: string;
  label: string;
  voice: { voiceIdentifier?: string; rate?: number; pitch?: number };
};

/** `refused` is a provider precondition; the rest are the native outcome. */
export type HandsfreeStartResult = HandsfreeStartOutcome | 'refused';

export type HandsfreeVoiceContextValue = {
  phase: HandsfreePhase;
  /** A call is live (not idle and not ended). */
  active: boolean;
  /** The live transcript of the current turn, for the banner. */
  partial: string;
  label: string | undefined;
  reason: HandsfreeTerminalReason | undefined;
  /** The latest 0–1 amplitude sample, when the platform supplies one. */
  level: number;
  /** Whether `start` can succeed right now. */
  canStart: boolean;
  start: (target: HandsfreeCallTarget) => Promise<HandsfreeStartResult>;
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

export function HandsfreeVoiceProvider({ children }: { children: React.ReactNode }) {
  const {
    activeGateway,
    status,
    currentSessionId,
    selectedBotId,
    pendingRunApproval,
    sendChatInput,
  } = useGateway();
  const { messages, isSending, isCommandRunning } = useChatSurface();

  const [session, setSession] = useState<HandsfreeSessionState>(INITIAL_HANDSFREE_SESSION);
  const [level, setLevel] = useState(0);
  const [availability, setAvailability] = useState<HandsfreeAvailability | null>(null);
  const [label, setLabel] = useState<string | undefined>(undefined);

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
        // depends on it, so a platform that omits it changes nothing.
        module.addListener('level', (event) => setLevel(clampLevel(event.level))),
      ];
    },
    [dispatch, unsubscribe],
  );

  const teardown = useCallback(async () => {
    if (endingRef.current) return;
    if (sessionRef.current.phase === 'idle' || sessionRef.current.phase === 'ended') return;
    endingRef.current = true;
    clearGrace();
    clearWatchdog();
    unsubscribe();
    endHandsfreeCall();
    const module = moduleRef.current;
    moduleRef.current = null;
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
      dispatch({ type: 'send-failed' });
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

  const runEffect = (effect: HandsfreeEffect) => {
    const module = moduleRef.current;
    switch (effect.kind) {
      case 'start-listening':
        void module?.startListening();
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
      dispatch({ type: 'reply-appeared' });
      return;
    }
    if (replyIdRef.current && reply.id !== replyIdRef.current) return;
    if (phase === 'waiting') {
      if (reply.text.trim()) dispatch({ type: 'reply-content' });
      return;
    }
    streamReplyText(reply.text, Boolean(reply.streaming));
  }, [messages, session.phase, dispatch, streamReplyText]);

  // Read the device's call capability while connected, so the Call control is
  // only offered where a tap can actually start a session.
  useEffect(() => {
    if (status !== 'connected') return undefined;
    let cancelled = false;
    void loadHandsfreeModule().then(async (module) => {
      if (cancelled) return;
      if (!module) return;
      try {
        const read = await module.getAvailability();
        if (!cancelled) setAvailability(read);
      } catch {
        if (!cancelled) setAvailability(null);
      }
    });
    return () => {
      cancelled = true;
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

  const start = useCallback(
    async (target: HandsfreeCallTarget): Promise<HandsfreeStartResult> => {
      if (sessionRef.current.phase !== 'idle') return 'refused';
      if (AppState.currentState !== 'active') return 'refused';
      const snapshot = latest.current;
      if (snapshot.status !== 'connected' || !snapshot.activeGateway) return 'refused';
      if (snapshot.activeGateway.id !== target.gatewayId) return 'refused';
      if (snapshot.isSending || snapshot.isCommandRunning || snapshot.pendingRunApproval) {
        return 'refused';
      }

      const module = await loadHandsfreeModule();
      if (!module) return 'unavailable';
      let read: HandsfreeAvailability;
      try {
        read = await module.getAvailability();
      } catch {
        return 'unavailable';
      }
      if (!read.recognition || !read.synthesis || !(read.maxSpeechInputLength > 0)) {
        return 'unavailable';
      }

      moduleRef.current = module;
      availabilityRef.current = read;
      setAvailability(read);
      targetRef.current = target;
      threadRef.current = callDraftThread(target);
      setLabel(target.label);
      endingRef.current = false;

      dispatch({ type: 'start' });
      const outcome = await module.startSession({ title: target.label });
      if (outcome !== 'started') {
        moduleRef.current = null;
        targetRef.current = null;
        threadRef.current = undefined;
        dispatch({ type: 'start-refused' });
        return outcome;
      }
      subscribe(module);
      beginHandsfreeCall();
      dispatch({ type: 'started' });
      return 'started';
    },
    [dispatch, subscribe],
  );

  const mute = useCallback(() => {
    dispatch({ type: 'mute' });
  }, [dispatch]);
  const unmute = useCallback(() => {
    dispatch({ type: 'unmute' });
  }, [dispatch]);
  const skipReply = useCallback(() => {
    dispatch({ type: 'skipReply' });
  }, [dispatch]);
  const end = useCallback(() => {
    dispatch({ type: 'end' });
  }, [dispatch]);

  const active = session.phase !== 'idle' && session.phase !== 'ended';
  const canStart =
    session.phase === 'idle' &&
    status === 'connected' &&
    Boolean(activeGateway) &&
    Boolean(availability?.recognition) &&
    Boolean(availability?.synthesis) &&
    (availability?.maxSpeechInputLength ?? 0) > 0 &&
    !isSending &&
    !isCommandRunning &&
    !pendingRunApproval;

  const value: HandsfreeVoiceContextValue = {
    phase: session.phase,
    active,
    partial: session.partial,
    label,
    reason: session.reason,
    level,
    canStart,
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
