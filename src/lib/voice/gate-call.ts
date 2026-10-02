// ─── The app side of a Gate-powered call ──────────────────────────────────
// When the Gate runs the call loop, the phone is only the microphone and
// speaker, and every piece of call state arrives as a JSON frame. This module
// is the pure half of that mode: it folds frames into the banner the screen
// draws, names the effects the provider must run (send a control, reload chat,
// tear down), and keeps the last operator turn as composer recovery text that
// is never sent on the call's behalf.
//
// It deliberately knows nothing about engines or backends: a call either has a
// Gate transport or it does not, and the provider branches on that alone.

import {
  parseGateFrame,
  serializeFrame,
  type GateVoiceFrame,
  type PhoneVoiceFrame,
  type VoicePhase,
  type VoiceSpeechState,
} from './voice-stream-protocol';

/** Which side drives a call. `gate` means the Gate owns the loop. */
export type HandsfreeCallTransport = 'phone' | 'gate';

export type GateCallPhase = VoicePhase | 'ended';

export type GateCallBanner = {
  phase: GateCallPhase;
  /** The engine the Gate actually used, once `ready` arrives. */
  engine: string | null;
  /** The live operator transcript. */
  partial: string;
  /** The reply text accumulated for the banner. */
  reply: string;
  turnState: 'sent' | 'replying' | 'done' | 'failed' | null;
  /**
   * Why the last turn died, in the Gate's own words, so the banner can say so
   * once. Null while no turn or non-fatal error has been reported.
   */
  turnError: string | null;
  speechGen: number;
  speechState: VoiceSpeechState | null;
  muted: boolean;
  approval: { turnId: string; summary: string } | null;
  endedReason: string | null;
  /**
   * A finished operator turn, held for the composer. It is recovery only: no
   * path turns it into a send, so a call can never speak on the operator's
   * behalf after the Gate has ended.
   */
  recovery: string;
};

export type GateCallEffect =
  | { kind: 'send-control'; frame: PhoneVoiceFrame }
  | { kind: 'reload-history' }
  | { kind: 'ended'; reason: string };

export const INITIAL_GATE_CALL: GateCallBanner = {
  phase: 'opening',
  engine: null,
  partial: '',
  reply: '',
  turnState: null,
  turnError: null,
  speechGen: 0,
  speechState: null,
  muted: false,
  approval: null,
  endedReason: null,
  recovery: '',
};

export type GateCallTransition = {
  state: GateCallBanner;
  effects: GateCallEffect[];
};

function stay(state: GateCallBanner, effects: GateCallEffect[] = []): GateCallTransition {
  return { state, effects };
}

/**
 * Fold one Gate frame into the banner. An unparseable or unknown frame is
 * inert rather than fatal: a newer Gate may add frames this build does not
 * know, and that must not end a live call. Once `ended` is seen the state is
 * terminal, so a late frame cannot tear a finished call down twice.
 */
export function reduceGateCall(
  state: GateCallBanner,
  input: GateVoiceFrame | string,
): GateCallTransition {
  if (state.phase === 'ended') return stay(state);

  let frame: GateVoiceFrame;
  if (typeof input === 'string') {
    try {
      frame = parseGateFrame(input);
    } catch {
      return stay(state);
    }
  } else {
    frame = input;
  }

  switch (frame.t) {
    case 'ready':
      return stay({ ...state, engine: frame.engine });

    case 'phase':
      // The Gate's phase frame is its whole account of the call, mute included.
      // Folding `muted` from the same frame is what stops the banner's label and
      // its mute flag from being two answers to one question.
      return stay({ ...state, phase: frame.phase, muted: frame.phase === 'muted' });

    case 'partial':
      return stay({ ...state, partial: frame.text });

    case 'final':
      // The Gate has already decided this turn is complete; the phone does not
      // send it. It is held so a dropped call can offer it back in the composer.
      // A new turn also clears the last one's failure: the Gate heard something
      // else, so that sentence is no longer this call's news.
      return stay({ ...state, partial: '', recovery: frame.text, turnError: null });

    case 'turn': {
      const next = { ...state, turnState: frame.state, turnError: frame.error ?? null };
      if (frame.state === 'failed') {
        // The turn died, the call did not. The Gate speaks its own failure line
        // and reopens listening, so the phone must not sit on `thinking`/`sending`
        // — or keep counting a slow turn — waiting for a reply that is never
        // coming. The reason is kept so the operator is told which turn died.
        return stay({ ...next, phase: 'listening' });
      }
      if (frame.state === 'done') {
        return stay({ ...next, reply: '', partial: '' }, [{ kind: 'reload-history' }]);
      }
      return stay(next);
    }

    case 'reply':
      return stay({ ...state, phase: 'speaking', reply: state.reply + frame.delta });

    case 'speech': {
      const next = { ...state, speechGen: frame.gen, speechState: frame.state };
      return stay(next);
    }

    case 'level':
      // Amplitude is banner-only and handled by the provider; it does not change
      // the folded state.
      return stay(state);

    case 'approval':
      return stay({ ...state, approval: { turnId: frame.turnId, summary: frame.summary } });

    case 'error':
      if (frame.fatal) {
        return {
          state: { ...state, phase: 'ended', endedReason: frame.code },
          effects: [{ kind: 'ended', reason: frame.code }],
        };
      }
      // A non-fatal error is the Gate's own news about this call and it is not
      // the end of it: it is named once on the banner, in the same words as a
      // failed turn, and folded away by the next turn that starts.
      return stay({ ...state, turnError: frame.message || frame.code });

    default:
      return {
        state: { ...state, phase: 'ended', endedReason: frame.reason },
        effects: [{ kind: 'ended', reason: frame.reason }],
      };
  }
}

/** The phone → Gate control frame for a banner action. */
export function gateControlFor(action: 'mute' | 'unmute' | 'skip' | 'end'): PhoneVoiceFrame {
  switch (action) {
    case 'mute':
      return { t: 'mute', on: true };
    case 'unmute':
      return { t: 'mute', on: false };
    case 'skip':
      return { t: 'skip' };
    default:
      return { t: 'end' };
  }
}

/** Encode a control frame the way the Gate parses it. */
export function serializeGateControl(frame: PhoneVoiceFrame): string {
  return serializeFrame(frame);
}

/**
 * The banner phase a Gate frame implies, in the app's own phase vocabulary, so
 * the existing call banner and controls need no Gate-specific branch. The Gate
 * distinguishes `thinking` where the phone reducer says `sending`.
 */
export type GateCallAppPhase = 'starting' | 'listening' | 'sending' | 'speaking' | 'muted' | 'ended';

export function appPhaseForGate(phase: GateCallPhase): GateCallAppPhase {
  switch (phase) {
    case 'opening':
      return 'starting';
    case 'thinking':
      return 'sending';
    case 'speaking':
      return 'speaking';
    case 'muted':
      return 'muted';
    case 'ended':
      return 'ended';
    default:
      return 'listening';
  }
}
