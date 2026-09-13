// ─── The Gate's call loop, one pure turn machine per call ────────────────
// Same discipline as the app's `reduceHandsfreeSession`: phases
// `opening → listening ⇄ thinking → speaking → listening`, plus `muted` and
// `ending → ended`; the engine, the turn runner and the phone all feed one
// reducer, and every transition names its effects. Nothing here reads a clock,
// storage or a socket.

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
        { ...state, phase: 'listening', turnId: event.turnId ?? state.turnId },
        [phaseEffect('listening')],
      );

    case 'partial':
      if (state.phase !== 'listening') return stay(state);
      return stay(state, [frameSend({ t: 'partial', text: event.text })]);

    case 'final':
    case 'handoff': {
      if (state.phase !== 'listening') return stay(state);
      const turnId = event.turnId ?? state.turnId;
      return stay({ ...state, phase: 'thinking', turnId, reply: '', spoken: '' }, [
        frameSend({ t: 'final', turnId, text: event.text }),
        phaseEffect('thinking'),
        { kind: 'turn.run', text: event.text },
      ]);
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
      return stay({ ...state, phase: back, resumePhase: null, muted: false }, [
        { kind: 'engine.setMuted', muted: false },
        phaseEffect(back),
      ]);
    }

    case 'bargein': {
      if (state.phase !== 'speaking') return stay(state);
      const cancelled = state.gen;
      return stay({ ...state, phase: 'listening', gen: state.gen + 1 }, [
        { kind: 'engine.cancelSpeech', gen: cancelled },
        phaseEffect('listening'),
      ]);
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
      return stay({ ...state, phase: 'listening', reply: '', spoken: '' }, [
        frameSend({ t: 'speech', gen: state.gen, state: 'end' }),
        phaseEffect('listening'),
      ]);
    }

    case 'speechAudio':
      return stay(state, [{ kind: 'sendAudio', pcm: event.pcm, gen: event.gen }]);

    default:
      return stay(state);
  }
}
