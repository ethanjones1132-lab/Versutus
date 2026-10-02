// ─── The Gate's call loop, one pure turn machine per call ────────────────
// Same discipline as the app's `reduceHandsfreeSession`: phases
// `opening → listening ⇄ thinking → speaking → listening`, plus `muted` and
// `ending → ended`; the engine, the turn runner and the phone all feed one
// reducer, and every transition names its effects. Nothing here reads a clock,
// storage or a socket.
//
// The one addition beyond a plain turn machine is the utterance hold. A
// recognizer's `final` is a sentence-sized segment, not the end of what the
// person wants to say, so segments are gathered into one utterance (`pendingText`)
// across a short hold and sent as a single turn. Speech heard while a turn runs
// is never dropped: it merges into that turn while the turn has not answered yet,
// and waits (`queued`) once it has.

import { completeSentenceLength } from './sentences.mjs';

export const VOICE_PHASES = Object.freeze([
  'opening',
  'listening',
  'thinking',
  'speaking',
  'muted',
  'ending',
  'ended',
]);

export const INITIAL_VOICE_SESSION = Object.freeze({
  phase: 'opening',
  gen: 0,
  reply: '',
  spoken: '',
  turnId: null,
  resumePhase: null,
  muted: false,
  endedReason: null,
  // The utterance being gathered and how many segments are in it, the speech
  // that arrived while a turn was running, and what that turn was sent and when
  // it was committed.
  pendingText: '',
  pendingFinals: 0,
  queued: [],
  committedText: '',
  committedAtMs: null,
  // The hold length and the continuation window travel in on `ready`: they are
  // the call's own clocks, and a session opened without them keeps the older
  // one-final-one-turn behaviour, which is what a hold of 0 means.
  utteranceHoldMs: 0,
  continuationMs: 0,
});

/** The line a failed turn speaks before the loop reopens. */
export const FAILED_TURN_LINE = 'Sorry, that turn could not be completed.';

function stay(state, effects = []) {
  return { state, effects };
}

function frameSend(frame) {
  return { kind: 'send', frame };
}

function phaseEffect(phase) {
  return frameSend({ t: 'phase', phase });
}

/** Every terminal path converges here, and only once. */
function endCall(state, reason) {
  return {
    state: { ...state, phase: 'ending', endedReason: reason },
    effects: [
      { kind: 'turn.cancel' },
      { kind: 'engine.cancelSpeech', gen: state.gen },
      frameSend({ t: 'ended', reason }),
      { kind: 'audit', event: 'ended', reason },
    ],
  };
}

/** Speak the reply's newly completed sentences, in order. */
function speakCompleted(state, effects) {
  const remaining = state.reply.slice(state.spoken.length);
  const boundary = completeSentenceLength(remaining);
  if (boundary <= 0) return state;
  const text = remaining.slice(0, boundary);
  effects.push({ kind: 'engine.speak', text, gen: state.gen, final: false });
  return { ...state, spoken: state.spoken + text };
}

/**
 * Join one recognizer segment onto the utterance being gathered. Segments in the
 * hold window are independent utterances cut by the recognizer's own silence
 * cutoff, so concatenation is the correct join, with a single space.
 */
function joinSpeech(held, next) {
  const trimmed = String(next ?? '').trim();
  if (!trimmed) return held.trim();
  return held ? `${held} ${trimmed}` : trimmed;
}

/** Hand the gathered utterance to the backend: one frame, one phase, one run. */
function commitUtterance(state, text, { finals = 1, nowMs = null, before = [] } = {}) {
  return {
    state: {
      ...state,
      phase: 'thinking',
      reply: '',
      spoken: '',
      pendingText: '',
      pendingFinals: 0,
      committedText: text,
      committedAtMs: nowMs,
    },
    effects: [
      ...before,
      frameSend({ t: 'final', turnId: state.turnId, text }),
      phaseEffect('thinking'),
      { kind: 'utterance.commit', chars: text.length, finals },
      { kind: 'turn.run', text },
    ],
  };
}

/** A final while listening: join it onto the utterance and hold for more. */
function hearFinal(state, event) {
  const merged = joinSpeech(state.pendingText, event.text);
  if (!merged) return stay(state);
  // A hold of 0 is the older behaviour: every segment is its own turn, at once.
  if (!(state.utteranceHoldMs > 0)) return commitUtterance(state, merged, { finals: 1 });
  const effects = [];
  // Merging means the person kept talking past a speculative turn started from
  // the first segment: that upstream is ended here, so one utterance is never
  // two live turns, and its replacement is started at the hold instead.
  if (state.pendingText) effects.push({ kind: 'turn.cancel' });
  effects.push(
    frameSend({ t: 'partial', text: merged }),
    { kind: 'hold.start', ms: state.utteranceHoldMs },
  );
  return stay({ ...state, pendingText: merged, pendingFinals: state.pendingFinals + 1 }, effects);
}

/**
 * A final while a turn runs is never dropped. While the turn has not answered
 * yet, and was committed recently enough, it is the same thought said in two
 * pieces: the turn is cancelled and one merged utterance is sent after the
 * hold. Otherwise it waits for its own turn.
 */
function hearDuringTurn(state, event) {
  const text = String(event.text ?? '').trim();
  if (!text) return stay(state);
  const heard = frameSend({ t: 'partial', text });
  if (isContinuation(state, event)) {
    const merged = joinSpeech(state.committedText, text);
    const merging = { kind: 'utterance.merge', chars: text.length };
    const gathered = {
      ...state,
      phase: 'listening',
      pendingText: merged,
      pendingFinals: 1,
      committedText: '',
      committedAtMs: null,
    };
    if (state.utteranceHoldMs > 0) {
      return stay(gathered, [
        merging,
        { kind: 'turn.cancel' },
        phaseEffect('listening'),
        frameSend({ t: 'partial', text: merged }),
        { kind: 'hold.start', ms: state.utteranceHoldMs },
      ]);
    }
    return commitUtterance(gathered, merged, { finals: 1, before: [merging] });
  }
  return stay({ ...state, queued: [...state.queued, text] }, [
    { kind: 'utterance.queue', chars: text.length },
    heard,
  ]);
}

/** Is this final the thought the running turn is still answering? */
function isContinuation(state, event) {
  if (state.phase !== 'thinking' || state.reply !== '') return false;
  if (!(state.continuationMs > 0)) return false;
  const elapsed = event.nowMs - state.committedAtMs;
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < state.continuationMs;
}

/** Someone started talking over the reply: the speech stops and the mic reopens. */
function bargeIn(state) {
  const cancelled = state.gen;
  return stay({ ...state, phase: 'listening', gen: state.gen + 1 }, [
    { kind: 'engine.cancelSpeech', gen: cancelled },
    phaseEffect('listening'),
  ]);
}

export function reduceVoiceSession(state, event) {
  // A call that is ending or ended consumes everything, so End, a fatal engine
  // error and a socket close cannot tear it down twice.
  if (state.phase === 'ending' || state.phase === 'ended') {
    if (event.type === 'ended') return stay({ ...state, phase: 'ended' });
    return stay(state);
  }

  if (event.type === 'end') return endCall(state, 'user');
  if (event.type === 'socketClosed') return endCall(state, event.reason ?? 'network');
  if (event.type === 'error' && event.fatal) return endCall(state, 'engine-error');
  if (event.type === 'error') {
    return stay(state, [
      frameSend({
        t: 'error',
        code: event.code ?? 'engine_error',
        message: event.message ?? 'error',
        fatal: false,
      }),
    ]);
  }

  switch (event.type) {
    case 'ready':
      if (state.phase !== 'opening') return stay(state);
      return stay(
        {
          ...state,
          phase: 'listening',
          turnId: event.turnId ?? state.turnId,
          utteranceHoldMs: event.utteranceHoldMs ?? state.utteranceHoldMs,
          continuationMs: event.continuationMs ?? state.continuationMs,
        },
        [phaseEffect('listening')],
      );

    case 'partial': {
      // The live transcript must not freeze while a turn runs, so what is still
      // being transcribed is forwarded even though it cannot be acted on yet.
      if (state.phase !== 'listening') {
        if (state.phase === 'thinking' || state.phase === 'speaking') {
          return stay(state, [frameSend({ t: 'partial', text: event.text })]);
        }
        return stay(state);
      }
      // A partial while an utterance is gathered means the person is still
      // talking: the hold restarts and the phone is shown everything said so far.
      // The partial itself joins nothing — it is the recognizer's running text
      // for a segment whose final is still to come, and folding it in would put
      // those words into the turn twice.
      if (state.pendingText) {
        return stay(state, [
          { kind: 'hold.start', ms: state.utteranceHoldMs },
          frameSend({ t: 'partial', text: `${state.pendingText} ${event.text}`.trim() }),
        ]);
      }
      return stay(state, [frameSend({ t: 'partial', text: event.text })]);
    }

    case 'final':
    case 'handoff': {
      if (state.phase === 'listening') return hearFinal(state, event);
      if (state.phase === 'thinking' || state.phase === 'speaking') {
        return hearDuringTurn(state, event);
      }
      return stay(state);
    }

    // The hold armed by the last segment elapsed. Nothing pending means there is
    // no utterance to send, which is what a timer that outlived its phase says.
    case 'holdElapsed': {
      if (state.phase !== 'listening') return stay(state);
      const text = state.pendingText.trim();
      if (!text) return stay(state);
      return commitUtterance(state, text, { finals: state.pendingFinals, nowMs: event.nowMs });
    }

    case 'userSpeechStart': {
      // From speaking this is the barge-in the phone's own frame also sends: the
      // speech stops, listening reopens, and the words that caused it arrive as
      // a normal final and go through the hold.
      if (state.phase === 'speaking') return bargeIn(state);
      // While an utterance is gathered the person is simply still talking, so
      // the hold restarts. Nothing is sent and nothing is dropped.
      if (state.phase === 'listening' && state.pendingText) {
        return stay(state, [{ kind: 'hold.start', ms: state.utteranceHoldMs }]);
      }
      // While the turn is still thinking it only says the words are coming: the
      // turn is not cancelled (nothing is being spoken yet), so the reply is
      // still owed, and the final that follows merges into it or waits for its
      // own turn rather than vanishing under the answer.
      return stay(state);
    }

    case 'mute': {
      if (state.phase === 'muted') return stay(state);
      if (state.phase !== 'listening' && state.phase !== 'speaking') return stay(state);
      return stay({ ...state, phase: 'muted', resumePhase: state.phase, muted: true }, [
        { kind: 'engine.setMuted', muted: true },
        phaseEffect('muted'),
      ]);
    }

    case 'unmute': {
      if (state.phase !== 'muted') return stay(state);
      const back = state.resumePhase === 'speaking' ? 'speaking' : 'listening';
      const effects = [{ kind: 'engine.setMuted', muted: false }, phaseEffect(back)];
      // A mute taken mid-hold held the utterance with it: the hold that elapsed
      // while the mic was shut could not send, so listening restarts it rather
      // than stranding words the person has already said.
      if (back === 'listening' && state.pendingText) {
        effects.push({ kind: 'hold.start', ms: state.utteranceHoldMs });
      }
      return stay({ ...state, phase: back, resumePhase: null, muted: false }, effects);
    }

    case 'bargein': {
      if (state.phase !== 'speaking') return stay(state);
      return bargeIn(state);
    }

    case 'skip': {
      if (state.phase !== 'speaking' && state.phase !== 'thinking') return stay(state);
      const cancelled = state.gen;
      return stay({ ...state, phase: 'listening', gen: state.gen + 1 }, [
        { kind: 'turn.cancel' },
        { kind: 'engine.cancelSpeech', gen: cancelled },
        phaseEffect('listening'),
      ]);
    }

    case 'replyDelta': {
      if (state.phase !== 'thinking' && state.phase !== 'speaking') return stay(state);
      const effects = [];
      let next = state;
      if (state.phase === 'thinking') {
        next = { ...state, phase: 'speaking', gen: state.gen + 1, reply: state.reply + event.text };
        effects.push(phaseEffect('speaking'));
      } else {
        next = { ...state, reply: state.reply + event.text };
      }
      effects.push(frameSend({ t: 'reply', turnId: next.turnId, delta: event.text }));
      next = speakCompleted(next, effects);
      return stay(next, effects);
    }

    case 'replyDone': {
      if (state.phase !== 'thinking' && state.phase !== 'speaking') return stay(state);
      if (state.phase === 'thinking') {
        const gen = state.gen + 1;
        return stay({ ...state, phase: 'speaking', gen, reply: FAILED_TURN_LINE, spoken: FAILED_TURN_LINE }, [
          phaseEffect('speaking'),
          frameSend({ t: 'turn', turnId: state.turnId, state: 'failed', error: 'empty turn' }),
          { kind: 'engine.speak', text: FAILED_TURN_LINE, gen, final: true },
        ]);
      }
      const remaining = state.reply.slice(state.spoken.length);
      const doneFrame = frameSend({ t: 'turn', turnId: state.turnId, state: 'done' });
      if (!remaining.trim()) return stay(state, [doneFrame]);
      return stay({ ...state, spoken: state.reply }, [
        { kind: 'engine.speak', text: remaining, gen: state.gen, final: true },
        doneFrame,
      ]);
    }

    case 'replyFailed': {
      if (state.phase !== 'thinking' && state.phase !== 'speaking') return stay(state);
      const gen = state.gen + 1;
      return stay({ ...state, phase: 'speaking', gen, reply: FAILED_TURN_LINE, spoken: FAILED_TURN_LINE }, [
        phaseEffect('speaking'),
        frameSend({ t: 'turn', turnId: state.turnId, state: 'failed', error: event.message }),
        { kind: 'engine.speak', text: FAILED_TURN_LINE, gen, final: true },
      ]);
    }

    case 'approvalRequired':
      return stay(state, [
        frameSend({ t: 'approval', turnId: state.turnId, summary: event.summary }),
      ]);

    case 'speechDone': {
      if (state.phase !== 'speaking') return stay(state);
      if (event.gen !== undefined && event.gen !== state.gen) return stay(state);
      const spoken = frameSend({ t: 'speech', gen: state.gen, state: 'end' });
      const queued = state.queued.join(' ').trim();
      // Anything heard while the reply was spoken is owed an answer of its own,
      // and it was waited for already: it goes as one turn, with no hold.
      if (queued) {
        return commitUtterance({ ...state, queued: [] }, queued, {
          finals: state.queued.length,
          nowMs: event.nowMs,
          before: [spoken],
        });
      }
      return stay({ ...state, phase: 'listening', reply: '', spoken: '' }, [
        spoken,
        phaseEffect('listening'),
      ]);
    }

    case 'speechAudio':
      return stay(state, [{ kind: 'sendAudio', pcm: event.pcm, gen: event.gen }]);

    default:
      return stay(state);
  }
}
