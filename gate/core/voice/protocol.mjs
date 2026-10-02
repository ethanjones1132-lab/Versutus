// ─── The phone ↔ Gate media protocol, parsed once ────────────────────────
// One fixture (`gate/__tests__/fixtures/voice-protocol.json`) is read by both this
// module's node:test and the app's Jest suite, so the two sides cannot drift. This
// file accepts JSON text or an already-parsed object, returns a normalised frame,
// and throws VoiceProtocolError on anything malformed or oversized.

export const MAX_FRAME_BYTES = 4096;

export const PHONE_FRAME_TYPES = Object.freeze(['mute', 'skip', 'bargein', 'end']);
export const GATE_FRAME_TYPES = Object.freeze([
  'ready',
  'phase',
  'partial',
  'final',
  'turn',
  'reply',
  'speech',
  'level',
  'approval',
  'error',
  'ended',
]);
export const PHASES = Object.freeze(['listening', 'thinking', 'speaking', 'muted']);
export const TURN_STATES = Object.freeze(['sent', 'replying', 'done', 'failed']);
// `gap` says the audio that was in front of this is gone: the head of a reply
// was dropped because the call's replay log overflowed while no phone was
// attached, and the chunks that follow belong to what it did not drop.
export const SPEECH_STATES = Object.freeze(['start', 'end', 'cancelled', 'gap']);

export class VoiceProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VoiceProtocolError';
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(frame, field) {
  const value = frame[field];
  if (typeof value !== 'string') throw new VoiceProtocolError(`${field} must be a string`);
  return value;
}

function requireNumber(frame, field) {
  const value = frame[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new VoiceProtocolError(`${field} must be a finite number`);
  }
  return value;
}

function requireEnum(frame, field, allowed) {
  const value = frame[field];
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new VoiceProtocolError(`${field} must be one of ${allowed.join(', ')}`);
  }
  return value;
}

function parseFrame(value, types, build) {
  let frame = value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_FRAME_BYTES) {
      throw new VoiceProtocolError('frame is too large');
    }
    try {
      frame = JSON.parse(value);
    } catch {
      throw new VoiceProtocolError('frame is not JSON');
    }
  }
  if (!isRecord(frame)) throw new VoiceProtocolError('frame must be an object');
  if (typeof frame.t !== 'string' || !types.includes(frame.t)) {
    throw new VoiceProtocolError(`unknown frame type: ${String(frame.t)}`);
  }
  return Object.freeze(build(frame));
}

/** Parse a phone → Gate control frame. */
export function parsePhoneFrame(value) {
  return parseFrame(value, PHONE_FRAME_TYPES, (frame) => {
    switch (frame.t) {
      case 'mute': {
        if (typeof frame.on !== 'boolean') throw new VoiceProtocolError('on must be a boolean');
        return { t: 'mute', on: frame.on };
      }
      case 'skip':
        return { t: 'skip' };
      case 'bargein':
        return { t: 'bargein' };
      default:
        return { t: 'end' };
    }
  });
}

/** Parse a Gate → phone frame. */
export function parseGateFrame(value) {
  return parseFrame(value, GATE_FRAME_TYPES, (frame) => {
    switch (frame.t) {
      case 'ready': {
        const ready = { t: 'ready', engine: requireString(frame, 'engine') };
        // How long the Gate will hold the call for without a phone, so the app
        // can match its own re-connect attempts to it instead of giving up
        // first. Optional: a Gate that does not send it is an older Gate.
        if (frame.resumeWindowMs !== undefined) {
          ready.resumeWindowMs = requireNumber(frame, 'resumeWindowMs');
        }
        return ready;
      }
      case 'phase':
        return { t: 'phase', phase: requireEnum(frame, 'phase', PHASES) };
      case 'partial':
        return { t: 'partial', text: requireString(frame, 'text') };
      case 'final':
        return { t: 'final', turnId: requireString(frame, 'turnId'), text: requireString(frame, 'text') };
      case 'turn': {
        const turn = {
          t: 'turn',
          turnId: requireString(frame, 'turnId'),
          state: requireEnum(frame, 'state', TURN_STATES),
        };
        if (frame.error !== undefined) turn.error = requireString(frame, 'error');
        return turn;
      }
      case 'reply':
        return { t: 'reply', turnId: requireString(frame, 'turnId'), delta: requireString(frame, 'delta') };
      case 'speech':
        return { t: 'speech', gen: requireNumber(frame, 'gen'), state: requireEnum(frame, 'state', SPEECH_STATES) };
      case 'level':
        return { t: 'level', v: requireNumber(frame, 'v') };
      case 'approval':
        return { t: 'approval', turnId: requireString(frame, 'turnId'), summary: requireString(frame, 'summary') };
      case 'error':
        if (typeof frame.fatal !== 'boolean') throw new VoiceProtocolError('fatal must be a boolean');
        return {
          t: 'error',
          code: requireString(frame, 'code'),
          message: requireString(frame, 'message'),
          fatal: frame.fatal,
        };
      default:
        return { t: 'ended', reason: requireString(frame, 'reason') };
    }
  });
}

/** Encode one frame as the JSON text a WebSocket text frame carries. */
export function serializeFrame(frame) {
  return JSON.stringify(frame);
}
