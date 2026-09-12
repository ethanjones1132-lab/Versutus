// ─── The pure hands-free call reducer ─────────────────────────────────────
// A call is a small deterministic turn machine. Every event the native module
// can report (Step 1's contract) has a defined destination here, so none is
// emitted-and-ignored; the provider above turns the reducer's effects into the
// native calls, and the reducer itself touches nothing — no timers, no
// storage, no microphone. That is what makes every transition in this file
// testable without a device.
//
// The one addition beyond a plain turn machine is the grace window. Fixed
// silence thresholds inevitably mistake a pause to think for "done talking" —
// OpenAI's original turn-based voice mode was interrupted mid-thought by
// exactly that rule. So a silence-triggered `final` does not send: it enters
// `confirming`, a short hold during which a resumed `partial`/`final` is
// concatenated onto the held text and the hold restarts. Only a hold that
// elapses with nothing new sends.

/** The phases a call moves through, in the order a turn meets them. */
export type HandsfreePhase =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'confirming'
  | 'sending'
  | 'waiting'
  | 'speaking'
  | 'muted'
  | 'ending'
  | 'ended';

/** Why a call reached a terminal phase. */
export type HandsfreeTerminalReason =
  | 'user'
  | 'disconnect'
  | 'system-interruption'
  | 'app-killed'
  | 'thread-changed'
  | 'recognition-failed'
  | 'send-failed'
  | 'speech-failed';

/**
 * What the provider must do natively for one transition. The reducer names the
 * intent; the provider owns the module call. `speak-reply` is a start signal
 * only — the provider speaks the correlated reply progressively, sentence by
 * sentence, as it streams.
 */
export type HandsfreeEffect =
  | { kind: 'start-listening' }
  | { kind: 'stop-listening' }
  | { kind: 'send-turn'; text: string }
  | { kind: 'speak-reply' }
  | { kind: 'stop-speaking' }
  | { kind: 'set-muted'; muted: boolean }
  | { kind: 'arm-grace' }
  | { kind: 'cancel-grace' }
  | { kind: 'play-earcon' }
  | { kind: 'stop-session' };

/** Everything that can arrive at the reducer, from native or the provider. */
export type HandsfreeEvent =
  | { type: 'start' }
  | { type: 'started' }
  | { type: 'start-refused' }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'noSpeech' }
  | { type: 'grace-elapsed' }
  | { type: 'send-accepted' }
  | { type: 'send-offline' }
  | { type: 'send-busy' }
  | { type: 'send-failed' }
  | { type: 'reply-appeared' }
  | { type: 'reply-content' }
  | { type: 'reply-failed' }
  | { type: 'speechFinished' }
  | { type: 'bargeIn' }
  | { type: 'skipReply' }
  | { type: 'interruption' }
  | { type: 'endRequested' }
  | { type: 'fatalError'; reason: 'recognition-failed' | 'speech-failed' }
  | { type: 'mute' }
  | { type: 'unmute' }
  | { type: 'end' }
  | { type: 'thread-changed' }
  | { type: 'disconnect' }
  | { type: 'stopped' };

export type HandsfreeSessionState = {
  phase: HandsfreePhase;
  /** Set only when the phase is `ending`/`ended`. */
  reason?: HandsfreeTerminalReason;
  /** The live transcript of the current turn, for the banner. */
  partial: string;
  /** The text accumulated for the pending turn (finals + grace-window speech). */
  held: string;
  /** Where unmute returns: the phase mute was entered from. */
  resumePhase?: 'listening' | 'speaking';
  /** Whether the correlated reply is still being spoken (mute does not stop it). */
  replyPlaying: boolean;
};

export const INITIAL_HANDSFREE_SESSION: HandsfreeSessionState = {
  phase: 'idle',
  partial: '',
  held: '',
  replyPlaying: false,
};

export type HandsfreeTransition = {
  state: HandsfreeSessionState;
  effects: HandsfreeEffect[];
};

/** A transition that changes nothing and asks for nothing. */
function stay(state: HandsfreeSessionState): HandsfreeTransition {
  return { state, effects: [] };
}

/** Enter a terminal handoff: every terminal path converges on `ending`. */
function endCall(
  state: HandsfreeSessionState,
  reason: HandsfreeTerminalReason,
  extra: HandsfreeEffect[] = [],
): HandsfreeTransition {
  const effects: HandsfreeEffect[] = [];
  if (state.phase === 'confirming') effects.push({ kind: 'cancel-grace' });
  effects.push(...extra);
  effects.push({ kind: 'stop-session' });
  return {
    state: {
      ...state,
      phase: 'ending',
      reason,
      partial: '',
      held: '',
      resumePhase: undefined,
      replyPlaying: false,
    },
    effects,
  };
}

/**
 * Join a new recognizer result onto the turn being accumulated. Results in the
 * grace window are independent utterances chunked by the recognizer's own
 * silence cutoff, not one continuous stream, so concatenation is the correct
 * join — with a single space, because the native side already trims each.
 */
function joinSpoken(held: string, next: string): string {
  if (!next.trim()) return held;
  if (!held) return next.trim();
  return `${held} ${next.trim()}`;
}

/**
 * Reduce one call event. Pure: the same state and event always answer the same
 * transition, and nothing here reads the clock, storage or a device.
 */
export function reduceHandsfreeSession(
  state: HandsfreeSessionState,
  event: HandsfreeEvent,
): HandsfreeTransition {
  const { phase } = state;

  // A call that is ending or ended consumes everything; End is idempotent and
  // a late native callback cannot reopen a finished call.
  if (phase === 'ended') return stay(state);
  if (phase === 'ending') {
    if (event.type === 'stopped') {
      return { state: { ...state, phase: 'ended' }, effects: [] };
    }
    return stay(state);
  }

  // Terminal events, valid from any live phase, all take the same path.
  if (event.type === 'end' || event.type === 'endRequested') {
    return endCall(state, 'user');
  }
  if (event.type === 'disconnect') return endCall(state, 'disconnect');
  if (event.type === 'thread-changed') return endCall(state, 'thread-changed');
  if (event.type === 'interruption') return endCall(state, 'system-interruption');
  if (event.type === 'fatalError') return endCall(state, event.reason);

  switch (phase) {
    case 'idle': {
      if (event.type === 'start') {
        return { state: { ...state, phase: 'starting' }, effects: [] };
      }
      return stay(state);
    }

    case 'starting': {
      if (event.type === 'started') {
        return {
          state: { ...state, phase: 'listening', partial: '', held: '' },
          effects: [{ kind: 'start-listening' }],
        };
      }
      if (event.type === 'start-refused') {
        return { state: { ...INITIAL_HANDSFREE_SESSION }, effects: [] };
      }
      return stay(state);
    }

    case 'listening': {
      if (event.type === 'partial') {
        return stay({ ...state, partial: event.text });
      }
      if (event.type === 'final') {
        if (!event.text.trim()) return stay(state);
        return {
          state: { ...state, phase: 'confirming', partial: event.text, held: event.text.trim() },
          effects: [{ kind: 'arm-grace' }],
        };
      }
      if (event.type === 'noSpeech') {
        return stay({ ...state, partial: '' });
      }
      if (event.type === 'mute') {
        return {
          state: { ...state, phase: 'muted', resumePhase: 'listening' },
          effects: [{ kind: 'set-muted', muted: true }],
        };
      }
      return stay(state);
    }

    case 'confirming': {
      if (event.type === 'partial' || event.type === 'final') {
        const held = joinSpoken(state.held, event.text);
        return {
          state: { ...state, held, partial: held },
          effects: [{ kind: 'arm-grace' }],
        };
      }
      if (event.type === 'noSpeech') return stay(state);
      if (event.type === 'grace-elapsed') {
        const text = state.held.trim();
        if (!text) return stay(state);
        return {
          state: { ...state, phase: 'sending', partial: '' },
          effects: [
            { kind: 'stop-listening' },
            { kind: 'send-turn', text },
            { kind: 'play-earcon' },
          ],
        };
      }
      if (event.type === 'mute') {
        return {
          state: {
            ...state,
            phase: 'muted',
            resumePhase: 'listening',
            partial: '',
            held: '',
          },
          effects: [{ kind: 'cancel-grace' }, { kind: 'set-muted', muted: true }],
        };
      }
      return stay(state);
    }

    case 'sending': {
      // The send promise is a confirmation only: success is read off the
      // correlated assistant message, so its resolution is a no-op here and in
      // every later phase.
      if (event.type === 'send-accepted') return stay(state);
      if (
        event.type === 'send-offline' ||
        event.type === 'send-busy' ||
        event.type === 'send-failed'
      ) {
        return endCall(state, 'send-failed');
      }
      if (event.type === 'reply-appeared') {
        return { state: { ...state, phase: 'waiting' }, effects: [] };
      }
      return stay(state);
    }

    case 'waiting': {
      if (event.type === 'reply-content') {
        return {
          state: { ...state, phase: 'speaking', replyPlaying: true },
          effects: [{ kind: 'speak-reply' }],
        };
      }
      if (event.type === 'reply-appeared') return stay(state);
      if (event.type === 'reply-failed') return endCall(state, 'send-failed');
      return stay(state);
    }

    case 'speaking': {
      if (event.type === 'speechFinished' || event.type === 'bargeIn' || event.type === 'skipReply') {
        return {
          state: { ...state, phase: 'listening', replyPlaying: false },
          effects: [{ kind: 'stop-speaking' }, { kind: 'start-listening' }],
        };
      }
      if (event.type === 'reply-failed') {
        // A reply the model retracted mid-speech is silenced at once rather
        // than finished; recognition reopens for the next turn.
        return {
          state: { ...state, phase: 'listening', replyPlaying: false },
          effects: [{ kind: 'stop-speaking' }, { kind: 'start-listening' }],
        };
      }
      if (event.type === 'mute') {
        return {
          state: { ...state, phase: 'muted', resumePhase: 'speaking' },
          effects: [{ kind: 'set-muted', muted: true }],
        };
      }
      return stay(state);
    }

    case 'muted': {
      if (event.type === 'speechFinished' || event.type === 'bargeIn') {
        return stay({ ...state, replyPlaying: false });
      }
      if (event.type === 'unmute') {
        const backToSpeaking = state.resumePhase === 'speaking' && state.replyPlaying;
        const next: HandsfreeSessionState = {
          ...state,
          phase: backToSpeaking ? 'speaking' : 'listening',
          resumePhase: undefined,
        };
        const effects: HandsfreeEffect[] = [{ kind: 'set-muted', muted: false }];
        if (!backToSpeaking) effects.push({ kind: 'start-listening' });
        return { state: next, effects };
      }
      return stay(state);
    }

    default:
      return stay(state);
  }
}
