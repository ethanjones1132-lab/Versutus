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

import { completeSentenceLength, openingClauseLength, openingPhraseLength } from './sentences.mjs';

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
  replyOffset: 0,
  spoken: '',
  turnId: null,
  turnCount: 0,
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
  // Engines without a Kokoro profile retain the legacy early-clause behavior.
  ttsChunkWords: null,
  ttsOpeningWords: 0, // already sent, not yet followed by the rest of its sentence
  // Whether the engine says the person is mid-utterance right now: speech is
  // open, a pause is still being judged, or a final is still being decoded. An
  // engine that reports it lets the hold be a short settle instead of a guess
  // long enough to cover a thinking pause; one that never does leaves this
  // false, and the hold alone decides as it always has.
  hearing: false,
  // That engine also says how much audio it has actually scored, so the settle
  // can be measured in audio rather than wall clock (VS-179). `settleEosMs` is
  // the end of the last final, `workerPositionMs` the engine's audio position,
  // and `settleArmed` says a hold was started after the audio had caught up.
  // `pendingDecodes` lets an endpoint's settle run before its final transcript.
  reportsHearing: false,
  utteranceSettleMs: 0,
  settleEosMs: null,
  workerPositionMs: null,
  settleArmed: false,
  settleInProgress: false,
  settleElapsed: false,
  pendingDecodes: 0,
  // The person started talking while their turn was still being thought about.
  // Until it is known whether that was words or a cough, the turn keeps running
  // and what it says is held here, unspoken and unsent, in the order it came.
  deferring: false,
  deferred: [],
});

/** What a running turn produces; the events held while the person is talking. */
const TURN_OUTPUT = new Set(['replyDelta', 'replyDone', 'replyFailed', 'toolUpdate', 'approvalRequired']);

/** The line a failed turn speaks before the loop reopens. */

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

/**
 * Is a running turn still owed a reply? A mute taken while the reply is being
 * spoken — or while it is still being thought about — suspends the audio, not
 * the turn: the turn's frames still belong to the phone, and letting them
 * through is what stops the call hanging in `muted`.
 */
function replyOwed(state) {
  if (state.phase === 'thinking' || state.phase === 'speaking') return true;
  return state.phase === 'muted'
    && (state.resumePhase === 'speaking' || state.resumePhase === 'thinking');
}

function speakJob(state, text, final, splitOpening = state.spoken === '') {
  return {
    kind: 'engine.speak', text, gen: state.gen, final, splitOpening,
    ...(state.ttsOpeningWords > 0 ? { openingPrefixWords: state.ttsOpeningWords } : {}),
  };
}

/**
 * Speak the reply's newly completed sentences, in order.
 *
 * The opening of a reply is the one place a sentence is not waited for. Gate
 * can send a safe opening phrase early; if the first sentence is already
 * complete, the worker instead finds the cut after cleaning its text.
 */
function speakCompleted(state, effects) {
  const remaining = state.reply.slice(state.spoken.length);
  let boundary = completeSentenceLength(remaining);
  const complete = boundary > 0;
  const opening = state.spoken === '';
  if (!complete && opening) {
    boundary = state.ttsChunkWords === null
      ? openingClauseLength(remaining)
      : openingPhraseLength(remaining, state.ttsChunkWords);
  }
  if (boundary <= 0) return state;
  const text = remaining.slice(0, boundary);
  effects.push(speakJob(state, text, false, opening && complete));
  const ttsOpeningWords = !complete && state.ttsChunkWords > 0 ? text.trim().split(/\s+/).length : 0;
  return { ...state, spoken: state.spoken + text, ttsOpeningWords };
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
  // A call id identifies the media session, not the committed user turn. The
  // monotonically increasing suffix also stays unique when a continuation is
  // merged into a fresh commit.
  const turnId = `turn-${state.turnCount + 1}`;
  return {
    state: {
      ...state,
      phase: 'thinking',
      turnId,
      turnCount: state.turnCount + 1,
      reply: '',
      replyOffset: 0,
      spoken: '',
      ttsOpeningWords: 0,
      pendingText: '',
      pendingFinals: 0,
      committedText: text,
      committedAtMs: nowMs,
      deferring: false,
      deferred: [],
      settleArmed: false,
      settleInProgress: false,
      settleElapsed: false,
      pendingDecodes: 0,
    },
    effects: [
      ...before,
      frameSend({ t: 'final', turnId, text }),
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
  const next = withFinalTiming(
    {
      ...state,
      pendingText: merged,
      pendingFinals: state.pendingFinals + 1,
      pendingDecodes: Math.max(0, state.pendingDecodes - 1),
    },
    event,
  );
  if (next.settleInProgress && next.settleElapsed && next.pendingDecodes === 0 && settleScored(next)) {
    return commitUtterance(next, merged, { finals: next.pendingFinals });
  }
  effects.push(
    frameSend({ t: 'partial', text: merged }),
    // While the engine says more is being heard, the clock does not run: the
    // utterance is sent when the person stops, not a guess after they paused.
    ...(next.settleInProgress ? [] : [holdEffect(next)]),
  );
  return stay({ ...next, settleArmed: settleScored(next) }, effects);
}

/**
 * Take the audio position a final was announced at. An engine that reports
 * hearing says how far it has actually scored; the Gate waits for the settle
 * past `eosMs` in that audio, not in its own clock (VS-179).
 */
function withFinalTiming(state, event) {
  return {
    ...state,
    // A final that carries no audio timing falls back to the wall clock, as
    // every engine did before this: never keep a previous final's position and
    // judge this one with it.
    settleEosMs: Number.isFinite(event.eosMs) ? event.eosMs : null,
    workerPositionMs: Number.isFinite(event.positionMs) ? event.positionMs : null,
    settleArmed: false,
  };
}

/**
 * Has the worker scored the settle past the last final's end? Engines that do
 * not report a position keep the wall clock's answer, which is all they have.
 */
function settleScored(state) {
  if (!state.reportsHearing) return true;
  if (!Number.isFinite(state.settleEosMs) || !Number.isFinite(state.workerPositionMs)) return true;
  return state.workerPositionMs >= state.settleEosMs + (state.utteranceSettleMs || 0);
}

/** Run the hold only while nothing more is being heard; otherwise stop it. */
function holdEffect(state) {
  return { kind: 'hold.start', ms: state.hearing ? 0 : state.utteranceHoldMs };
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
  // The held turn finished answering while the person was still talking. Its
  // answer is already in the thread, so taking the turn back would only send
  // the first half a second time behind a reply nobody heard. What was held is
  // not spoken (it answers half a thought), the phone is told the turn is done
  // so the thread shows it, and what was just said goes as the next turn: the
  // Bot has the first half and its own answer in front of it.
  if (state.deferring && state.deferred.some((held) => held.type === 'replyDone')) {
    const next = withFinalTiming({
      ...state,
      phase: 'listening',
      pendingText: text,
      pendingFinals: 1,
      committedText: '',
      committedAtMs: null,
      deferring: false,
      deferred: [],
    }, event);
    return stay({ ...next, settleArmed: settleScored(next) }, [
      frameSend({ t: 'turn', turnId: state.turnId, state: 'done' }),
      phaseEffect('listening'),
      heard,
      holdEffect(next),
    ]);
  }
  if (isContinuation(state, event)) {
    const merged = joinSpeech(state.committedText, text);
    const merging = { kind: 'utterance.merge', chars: text.length };
    const gathered = withFinalTiming({
      ...state,
      phase: 'listening',
      pendingText: merged,
      pendingFinals: 1,
      committedText: '',
      committedAtMs: null,
      // The turn is withdrawn, so whatever it had said while held goes with it.
      deferring: false,
      deferred: [],
    }, event);
    if (state.utteranceHoldMs > 0) {
      return stay({ ...gathered, settleArmed: settleScored(gathered) }, [
        merging,
        { kind: 'turn.cancel' },
        phaseEffect('listening'),
        frameSend({ t: 'partial', text: merged }),
        holdEffect(gathered),
      ]);
    }
    return commitUtterance(gathered, merged, { finals: 1, before: [merging] });
  }
  return stay({ ...state, queued: [...state.queued, text] }, [
    { kind: 'utterance.queue', chars: text.length },
    heard,
  ]);
}

/** Let a held turn speak: fold what it said while held back in, in order. */
function releaseDeferred(state) {
  let current = { ...state, deferring: false, deferred: [] };
  const effects = [];
  for (const event of state.deferred) {
    const out = reduceVoiceSession(current, event);
    current = out.state;
    effects.push(...out.effects);
  }
  return stay(current, effects);
}

/** Is this final the thought the running turn is still answering? */
function isContinuation(state, event) {
  if (state.phase !== 'thinking' || state.reply !== '') return false;
  if (!(state.continuationMs > 0)) return false;
  // A turn already being held for this speech is its continuation however long
  // the sentence took to say: the window was judged when the speech began.
  if (state.deferring) return true;
  const elapsed = event.nowMs - state.committedAtMs;
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < state.continuationMs;
}

/**
 * Someone started talking over the reply: the speech stops and the mic reopens.
 * The turn behind the reply is cancelled too. It is talked over, not finished,
 * and left running it would keep answering into whatever turn comes next.
 */
function bargeIn(state) {
  const cancelled = state.gen;
  return stay({ ...state, phase: 'listening', gen: state.gen + 1 }, [
    frameSend({ t: 'speech', gen: cancelled, state: 'cancelled' }),
    { kind: 'turn.cancel' },
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
    const next = event.code === 'stt_failed'
      ? { ...state, pendingDecodes: Math.max(0, state.pendingDecodes - 1) }
      : state;
    return stay(next, [
      frameSend({
        t: 'error',
        code: event.code ?? 'engine_error',
        message: event.message ?? 'error',
        fatal: false,
      }),
    ]);
  }

  // While the person is talking over a turn that has not answered yet, what the
  // turn produces is held: nothing is spoken over them and nothing is shown,
  // and the turn itself is left running until it is known what they said.
  if (state.deferring && TURN_OUTPUT.has(event.type)) {
    return stay({ ...state, deferred: [...state.deferred, event] });
  }

  switch (event.type) {
    case 'ready': {
      if (state.phase !== 'opening') return stay(state);
      const phase = state.muted ? 'muted' : 'listening';
      return stay(
        {
          ...state,
          phase,
          resumePhase: state.muted ? 'listening' : null,
          turnId: event.turnId ?? state.turnId,
          utteranceHoldMs: event.utteranceHoldMs ?? state.utteranceHoldMs,
          utteranceSettleMs: event.utteranceSettleMs ?? state.utteranceSettleMs,
          reportsHearing: event.reportsHearing ?? state.reportsHearing,
          continuationMs: event.continuationMs ?? state.continuationMs,
          ttsChunkWords: event.ttsChunkWords ?? state.ttsChunkWords,
        },
        state.muted ? [{ kind: 'engine.setMuted', muted: true }, phaseEffect(phase)] : [phaseEffect(phase)],
      );
    }

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
          holdEffect(state),
          frameSend({ t: 'partial', text: `${state.pendingText} ${event.text}`.trim() }),
        ]);
      }
      return stay(state, [frameSend({ t: 'partial', text: event.text })]);
    }

    // The engine's own word on whether the person is mid-utterance. It moves no
    // phase and sends no frame; it only decides whether the hold may run. A
    // gathered utterance waits while more is being heard and is sent a short
    // settle after it is not.
    case 'hearing':
    case 'endOfSpeech': {
      if (event.type === 'endOfSpeech') {
        if (state.phase !== 'listening') return stay(state);
        const next = {
          ...state,
          hearing: false,
          settleEosMs: Number.isFinite(event.eosMs) ? event.eosMs : null,
          workerPositionMs: Number.isFinite(event.positionMs) ? event.positionMs : state.workerPositionMs,
          settleArmed: false,
          settleInProgress: true,
          settleElapsed: false,
          pendingDecodes: state.pendingDecodes + 1,
        };
        return stay(next, state.utteranceHoldMs > 0 ? [{ kind: 'hold.start', ms: state.utteranceHoldMs }] : []);
      }
      const hearing = Boolean(event.active);
      const positionMs = Number.isFinite(event.positionMs) ? event.positionMs : state.workerPositionMs;
      const next = { ...state, hearing, workerPositionMs: positionMs };
      if (hearing && state.settleInProgress) {
        return stay({
          ...next,
          settleEosMs: null,
          settleArmed: false,
          settleInProgress: false,
          settleElapsed: false,
        }, [{ kind: 'hold.start', ms: 0 }]);
      }
      if (hearing === state.hearing) {
        // The flag did not change, but the worker may have caught up to the
        // audio its last final needed (VS-179). A false read taken before the
        // resumed speech was scored no longer holds the turn back once the
        // settle has been heard.
        if (
          !hearing
          && state.phase === 'listening'
          && next.pendingText
          && !state.settleArmed
          && settleScored(next)
        ) {
          if (state.settleInProgress && state.settleElapsed && state.pendingDecodes === 0) {
            return commitUtterance(next, next.pendingText, { finals: next.pendingFinals });
          }
          return stay({ ...next, settleArmed: true }, [holdEffect(next)]);
        }
        return stay(next);
      }
      // The sound that held the turn's reply back has stopped and no words came
      // of it (a final arrives before this, and takes the turn back): it was a
      // cough or a door. The turn was never touched, and what it said while
      // held is released now, in order.
      if (!hearing && state.deferring) return releaseDeferred(next);
      if (state.phase === 'listening' && state.pendingText) {
        return stay({ ...next, settleArmed: settleScored(next) }, [holdEffect(next)]);
      }
      return stay(next);
    }

    case 'final':
    case 'handoff': {
      if (state.phase === 'listening') return hearFinal(state, event);
      if (state.phase === 'thinking' || state.phase === 'speaking') {
        return hearDuringTurn(state, event);
      }
      return stay(state);
    }

    case 'noSpeechDrop': {
      const next = { ...state, pendingDecodes: Math.max(0, state.pendingDecodes - 1) };
      if (
        next.settleInProgress
        && next.settleElapsed
        && next.pendingDecodes === 0
        && next.pendingText
        && settleScored(next)
      ) {
        return commitUtterance(next, next.pendingText, { finals: next.pendingFinals });
      }
      return stay(next);
    }

    // The person started talking again while their turn was still being thought
    // about, and nothing has been said back yet. If these are words, the turn is
    // theirs to extend: the final that follows takes it back and sends both
    // halves as one. Waiting for that final with the reply free to start (as the
    // call used to) was too late — by the time a sentence has been spoken and
    // decoded the reply had usually begun, and the call answered the first half,
    // played all of it, and then answered the second half on its own (a live
    // trace, 2026-11-15). So from here the turn's output is held. The turn is
    // not cancelled yet: a cough is not a sentence, and re-sending a prompt for
    // one would run it twice.
    case 'userSpeaking': {
      if (state.deferring || !isContinuation(state, event)) return stay(state);
      return stay({ ...state, deferring: true, deferred: [], hearing: true });
    }

    // The hold armed by the last segment elapsed. Nothing pending means there is
    // no utterance to send, which is what a timer that outlived its phase says.
    case 'holdElapsed': {
      if (state.phase !== 'listening') return stay(state);
      // A timer that fired in the same instant the person started again: the
      // utterance is still growing, and it is sent when the engine says it is not.
      if (state.hearing) return stay(state);
      const text = state.pendingText.trim();
      if (!text) {
        return stay(state.settleInProgress ? { ...state, settleElapsed: true } : state);
      }
      if (state.pendingDecodes > 0) {
        return stay({ ...state, settleElapsed: true });
      }
      // The wall clock has run, but an engine that reports hearing has not
      // necessarily scored the audio behind it. Until it has, the resumed speech
      // may still be queued and this prefix is only half the utterance (VS-179).
      if (!settleScored(state)) {
        return stay({
          ...state,
          settleArmed: false,
          settleElapsed: state.settleInProgress,
        });
      }
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
        return stay(state, [holdEffect(state)]);
      }
      // While the turn is still thinking it only says the words are coming: the
      // turn is not cancelled (nothing is being spoken yet), so the reply is
      // still owed, and the final that follows merges into it or waits for its
      // own turn rather than vanishing under the answer.
      return stay(state);
    }

    case 'mute': {
      // A phone can attach (or resume) while the worker is still opening. Keep
      // the requested mic state now, but don't claim the worker is ready yet.
      if (state.phase === 'opening') return stay({ ...state, muted: true });
      if (state.phase === 'muted') return stay(state);
      // A mute from `thinking` is the one the operator reaches for most: the
      // microphone has to go off while the PC is still answering. Refusing it
      // here left the phone's capture muted, the Gate's engine hearing, and no
      // `phase: muted` frame for either side to agree on — three answers to one
      // question, and the banner waiting five seconds for a frame that was
      // never sent. The turn keeps running (resumePhase remembers where to go
      // back to), so its reply is still delivered and spoken after unmute.
      if (state.phase !== 'listening' && state.phase !== 'speaking' && state.phase !== 'thinking') {
        return stay(state);
      }
      // Mute turns the microphone off; it never cuts the Bot off. A reply that is
      // playing keeps playing (VS-023), so no speech cancel is sent here.
      // Mute also ends whatever was being heard: the microphone is off, so an
      // open utterance can never close, and a call left "hearing" would hold a
      // gathered turn for ever after unmute.
      return stay({ ...state, phase: 'muted', resumePhase: state.phase, muted: true, hearing: false }, [
        { kind: 'engine.setMuted', muted: true },
        phaseEffect('muted'),
      ]);
    }

    case 'unmute': {
      if (state.phase === 'opening') return stay({ ...state, muted: false });
      if (state.phase !== 'muted') return stay(state);
      // Back to whatever the mute interrupted: a reply that was playing, or a
      // turn that was still being thought about. Only a mute taken from
      // `listening` reopens the microphone.
      const back = state.resumePhase === 'speaking'
        ? 'speaking'
        : state.resumePhase === 'thinking' ? 'thinking' : 'listening';
      const effects = [{ kind: 'engine.setMuted', muted: false }, phaseEffect(back)];
      // A mute taken mid-hold held the utterance with it: the hold that elapsed
      // while the mic was shut could not send, so listening restarts it rather
      // than stranding words the person has already said.
      if (back === 'listening' && state.pendingText) {
        effects.push(holdEffect(state));
      }
      return stay({ ...state, phase: back, resumePhase: null, muted: false }, effects);
    }

    case 'skip': {
      if (state.phase !== 'speaking' && state.phase !== 'thinking') return stay(state);
      const cancelled = state.gen;
      return stay({ ...state, phase: 'listening', gen: state.gen + 1, deferring: false, deferred: [] }, [
        frameSend({ t: 'speech', gen: cancelled, state: 'cancelled' }),
        { kind: 'turn.cancel' },
        { kind: 'engine.cancelSpeech', gen: cancelled },
        phaseEffect('listening'),
      ]);
    }

    case 'replyDelta': {
      if (!replyOwed(state)) return stay(state);
      const effects = [];
      let next = state;
      if (state.phase === 'thinking') {
        next = { ...state, phase: 'speaking', gen: state.gen + 1, reply: state.reply + event.text, replyOffset: state.replyOffset + event.text.length };
        effects.push(phaseEffect('speaking'), frameSend({ t: 'speech', gen: next.gen, state: 'start' }));
      } else {
        next = { ...state, reply: state.reply + event.text, replyOffset: state.replyOffset + event.text.length };
      }
      effects.push(frameSend({ t: 'reply', turnId: next.turnId, offset: state.replyOffset, delta: event.text }));
      // A muted reply still reaches the phone, but none of it is spoken: the
      // sentences are marked as handled so unmuting resumes at the next one
      // rather than replaying what was said while the mic was shut.
      next = state.phase === 'muted'
        ? { ...next, spoken: next.reply, ttsOpeningWords: 0 }
        : speakCompleted(next, effects);
      return stay(next, effects);
    }

    case 'replyDone': {
      if (!replyOwed(state)) return stay(state);
      // The turn is finished even though the audio was muted, so its end frame is
      // still owed. The call stays muted and the microphone reopens on unmute.
      if (state.phase === 'muted') {
        return stay({ ...state, reply: '', spoken: '', resumePhase: 'listening' }, [
          frameSend({ t: 'turn', turnId: state.turnId, state: 'done' }),
          { kind: 'speech.close', gen: state.gen },
        ]);
      }
      if (state.phase === 'thinking') {
        return reduceVoiceSession(state, { ...event, type: 'replyFailed', message: 'The backend finished without replying.' });
      }
      // The reply's text is complete. Its speech is not: sentences are still
      // being synthesised and played, so the reply is only closed here — no
      // more will be asked of this generation — and the socket reports
      // `speechDone` when the last of it has actually been heard.
      const remaining = state.reply.slice(state.spoken.length);
      const doneFrame = frameSend({ t: 'turn', turnId: state.turnId, state: 'done' });
      const closed = { kind: 'speech.close', gen: state.gen };
      if (!remaining.trim()) return stay(state, [doneFrame, closed]);
      return stay({ ...state, spoken: state.reply, ttsOpeningWords: 0 }, [
        speakJob(state, remaining, true),
        doneFrame,
        closed,
      ]);
    }

    case 'replyFailed': {
      if (!replyOwed(state)) return stay(state);
      const failure = frameSend({ t: 'turn', turnId: state.turnId, state: 'failed', error: event.message });
      if (state.phase === 'muted') {
        return stay({ ...state, reply: '', spoken: '', resumePhase: 'listening' }, [
          failure,
          { kind: 'speech.close', gen: state.gen },
        ]);
      }
      // Finish what the Bot actually said. The failure is banner copy, not a
      // fabricated reply, and never starts a speech generation.
      if (state.phase === 'speaking') {
        const tail = state.reply.slice(state.spoken.length);
        return stay({ ...state, spoken: state.reply, ttsOpeningWords: 0 }, [
          failure,
          ...(tail.trim() ? [speakJob(state, tail, true)] : []),
          { kind: 'speech.close', gen: state.gen },
        ]);
      }
      const queued = state.queued.join(' ').trim();
      if (queued) return commitUtterance({ ...state, queued: [] }, queued, {
        finals: state.queued.length, nowMs: event.nowMs, before: [failure],
      });
      return stay({ ...state, phase: 'listening', reply: '', spoken: '' }, [failure, phaseEffect('listening')]);
    }

    // The runner reports tool lifecycle while the turn runs. It is the turn's
    // news even though it is not the call's: the phone shows the card, and a
    // frame is safe to carry because the runner's summary is bounded and holds
    // no arguments or output.
    case 'toolUpdate':
      if (!state.turnId) return stay(state);
      return stay(state, [
        frameSend({
          t: 'tool',
          turnId: state.turnId,
          toolId: event.toolId,
          name: event.name,
          status: event.status,
          summary: event.summary,
        }),
      ]);

    case 'approvalRequired': {
      const effects = [
        frameSend({
          t: 'approval',
          turnId: state.turnId,
          summary: event.summary,
          ...(typeof event.approvalId === 'string' ? { approvalId: event.approvalId } : {}),
          ...(typeof event.state === 'string' ? { state: event.state } : {}),
          ...(event.gateDecision === true ? { gateDecision: true } : {}),
        }),
      ];
      if (!event.speech || !replyOwed(state) || state.phase === 'muted') return stay(state, effects);
      const next = state.phase === 'thinking'
        ? { ...state, phase: 'speaking', gen: state.gen + 1 }
        : state;
      if (next !== state) {
        effects.push(phaseEffect('speaking'), frameSend({ t: 'speech', gen: next.gen, state: 'start' }));
      }
      // This is a Gate announcement, not a Bot reply: don't append it to the
      // reply text, offsets, push notifications or transcript. Leave the
      // generation open for expiry and the backend's eventual reply.
      effects.push({ kind: 'engine.speak', text: event.speech, gen: next.gen, final: false });
      return stay(next, effects);
    }

    case 'speechDone': {
      // Audio started before the mute may still be finishing. Its end is still
      // the phone's news, but nothing speaks while muted: the call stays muted
      // and the microphone reopens on unmute.
      if (state.phase === 'muted') {
        if (event.gen !== undefined && event.gen !== state.gen) return stay(state);
        return stay(state, [frameSend({ t: 'speech', gen: state.gen, state: 'end' })]);
      }
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
