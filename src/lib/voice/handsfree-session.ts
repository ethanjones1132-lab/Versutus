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
  | 'speech-failed'
  /**
   * The audio link to the Gate went away and could not be rejoined inside the
   * Gate's resume window. Its own reason: the call was not ended by anyone, the
   * link simply died, and folding the socket frame as the operator's own End
   * would have reported a drop as a walk-away.
   */
  | 'link-lost';

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
  | { type: 'started'; startedAtMs?: number }
  | { type: 'start-refused' }
  | { type: 'start-timeout' }
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
  | { type: 'linkLost' }
  | { type: 'endRequested'; reason?: 'app-killed' }
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
  /** Why the previous call ended, kept after it returns to idle so the screen can say so. */
  lastEndReason?: HandsfreeTerminalReason;
  /** How many calls have finished, so a screen can react to a repeat failure. */
  callsEnded: number;
  /** The live transcript of the current turn, for the banner. */
  partial: string;
  /** The text accumulated for the pending turn (finals + grace-window speech). */
  held: string;
  /** The epoch (`Date.now()`) at which the call actually started, so the
   * surface can say how long it has been running; set only once the
   * native side confirms `started`. The reducer stays clock-free — the
   * provider stamps the value in. */
  startedAtMs?: number;
  /** Where unmute returns: the phase mute was entered from. */
  resumePhase?: 'listening' | 'speaking';
  /**
   * A mute tapped while a turn was already in flight. The turn is not cancelled
   * by it — the words were said and the reply is still owed — so the intent is
   * recorded here and honoured when the turn would have reopened the
   * microphone.
   */
  muteIntent?: boolean;
  /** Whether the correlated reply is still being spoken (mute does not stop it). */
  replyPlaying: boolean;
};

export const INITIAL_HANDSFREE_SESSION: HandsfreeSessionState = {
  phase: 'idle',
  callsEnded: 0,
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
      muteIntent: undefined,
      replyPlaying: false,
    },
    effects,
  };
}

/**
 * Where a turn goes once its reply is done or failed. A mute tapped while the
 * turn was in flight lands here: the microphone is muted and the call waits in
 * `muted` instead of opening it, which is the only thing the tap asked for. The
 * intent is consumed, so unmute resumes recognition as it does from any mute.
 */
function afterReply(
  state: HandsfreeSessionState,
  effects: HandsfreeEffect[],
): HandsfreeTransition {
  if (!state.muteIntent) {
    return { state: { ...state, phase: 'listening', replyPlaying: false }, effects };
  }
  return {
    state: {
      ...state,
      phase: 'muted',
      resumePhase: 'listening',
      replyPlaying: false,
      muteIntent: undefined,
    },
    // The microphone was told to stay shut, so recognising does not reopen it.
    effects: effects.filter((effect) => effect.kind !== 'start-listening'),
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

  // Idle answers only a Start. A late End, fatal error or transcript from a call
  // that already finished must not open a second teardown.
  if (phase === 'idle') {
    if (event.type === 'start') {
      return { state: { ...state, phase: 'starting', lastEndReason: undefined }, effects: [] };
    }
    return stay(state);
  }

  // `ended` is no longer produced: a stopped call returns to idle. A state held
  // over from an older build still consumes everything.
  if (phase === 'ended') return stay(state);
  if (phase === 'ending') {
    if (event.type === 'stopped') {
      return {
        state: {
          ...INITIAL_HANDSFREE_SESSION,
          lastEndReason: state.reason,
          callsEnded: state.callsEnded + 1,
        },
        effects: [],
      };
    }
    return stay(state);
  }

  // Terminal events, valid from any live phase, all take the same path.
  if (event.type === 'end') return endCall(state, 'user');
  if (event.type === 'endRequested') {
    // The notification's End is the operator's own. The platform also ends a
    // call nobody asked to end when its foreground service dies under a live JS
    // runtime, and that is a fact with its own sentence to say — not a call the
    // operator silently walked away from.
    return endCall(state, event.reason ?? 'user');
  }
  if (event.type === 'disconnect') return endCall(state, 'disconnect');
  if (event.type === 'linkLost') return endCall(state, 'link-lost');
  if (event.type === 'thread-changed') return endCall(state, 'thread-changed');
  if (event.type === 'interruption') return endCall(state, 'system-interruption');
  if (event.type === 'fatalError') return endCall(state, event.reason);

  switch (phase) {
    case 'starting': {
      if (event.type === 'started') {
        return {
          state: { ...state, phase: 'listening', partial: '', held: '', startedAtMs: event.startedAtMs },
          effects: [{ kind: 'start-listening' }],
        };
      }
      if (event.type === 'start-refused') {
        return { state: { ...INITIAL_HANDSFREE_SESSION, callsEnded: state.callsEnded }, effects: [] };
      }
      // A start the provider gave up on. It must return to idle for the same
      // reason a refusal does: this is the only way back for a start that was
      // abandoned mid-flight, and `canStart` is offered from `idle` only — so
      // without this the user's one retry was never available to them. No
      // `stop-session` effect: nothing ever started, so there is nothing to stop
      // and nothing to count as a call that finished.
      if (event.type === 'start-timeout') {
        return { state: { ...INITIAL_HANDSFREE_SESSION, callsEnded: state.callsEnded }, effects: [] };
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
      // Mute does not cancel a turn the operator already said out loud. It
      // records the intent, mutes the microphone now, and is honoured when the
      // turn would have reopened it — the same effect every other phase emits.
      if (event.type === 'mute') {
        return {
          state: { ...state, muteIntent: true },
          effects: [{ kind: 'set-muted', muted: true }],
        };
      }
      if (event.type === 'unmute') {
        if (!state.muteIntent) return stay(state);
        return {
          state: { ...state, muteIntent: undefined },
          effects: [{ kind: 'set-muted', muted: false }],
        };
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
      // A mute tapped while the turn was in flight is honoured on the way back:
      // the call waits muted rather than opening the microphone it was told to
      // keep shut.
      if (event.type === 'mute') {
        return {
          state: { ...state, muteIntent: true },
          effects: [{ kind: 'set-muted', muted: true }],
        };
      }
      if (event.type === 'unmute') {
        if (!state.muteIntent) return stay(state);
        return {
          state: { ...state, muteIntent: undefined },
          effects: [{ kind: 'set-muted', muted: false }],
        };
      }
      // A reply that errored while it streamed is the same fact as one
      // retracted mid-speech: recognition reopens for the next turn instead
      // of killing the whole call. No speech started, so stop-speaking is a
      // no-op the module tolerates.
      if (event.type === 'reply-failed') {
        return afterReply(state, [{ kind: 'stop-speaking' }, { kind: 'start-listening' }]);
      }
      return stay(state);
    }

    case 'speaking': {
      if (event.type === 'speechFinished' || event.type === 'bargeIn' || event.type === 'skipReply') {
        return afterReply(state, [{ kind: 'stop-speaking' }, { kind: 'start-listening' }]);
      }
      if (event.type === 'reply-failed') {
        // A reply the model retracted mid-speech is silenced at once rather
        // than finished; recognition reopens for the next turn.
        return afterReply(state, [{ kind: 'stop-speaking' }, { kind: 'start-listening' }]);
      }
      if (event.type === 'mute') {
        return {
          state: { ...state, phase: 'muted', resumePhase: 'speaking' },
          effects: [{ kind: 'set-muted', muted: true }],
        };
      }
      // This is where a mute taken while the turn was in flight arrives, with
      // the reply still being read aloud. The banner offers Unmute for it, so it
      // has to do something: the microphone goes back, the reply finishes being
      // spoken, and `afterReply` finds no intent and reopens listening.
      if (event.type === 'unmute') {
        if (!state.muteIntent) return stay(state);
        return {
          state: { ...state, muteIntent: undefined },
          effects: [{ kind: 'set-muted', muted: false }],
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
          // An intent that has been honoured by reaching `muted` is spent: the
          // operator has the microphone back, so the next turn must not be
          // ended by a mute they lifted.
          muteIntent: undefined,
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
