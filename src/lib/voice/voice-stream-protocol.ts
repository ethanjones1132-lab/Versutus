// ─── The phone side of the Gate media protocol ───────────────────────────
// The mirror of `gate/core/voice/protocol.mjs`. Both read the one fixture at
// `gate/__tests__/fixtures/voice-protocol.json`, so a frame added on one side
// without the other fails a test rather than a call.

export const MAX_FRAME_BYTES = 4096;

export const PHONE_FRAME_TYPES = ['mute', 'skip', 'bargein', 'end'] as const;
export const GATE_FRAME_TYPES = [
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
] as const;
export const PHASES = ['listening', 'thinking', 'speaking', 'muted'] as const;
export const TURN_STATES = ['sent', 'replying', 'done', 'failed'] as const;
export const SPEECH_STATES = ['start', 'end', 'cancelled'] as const;

export type VoicePhase = (typeof PHASES)[number];
export type VoiceTurnState = (typeof TURN_STATES)[number];
export type VoiceSpeechState = (typeof SPEECH_STATES)[number];
export type VoiceEngineId = 'local' | 'codex' | 'phone';

export type PhoneVoiceFrame =
  | { t: 'mute'; on: boolean }
  | { t: 'skip' }
  | { t: 'bargein' }
  | { t: 'end' };

export type GateVoiceFrame =
  | { t: 'ready'; engine: VoiceEngineId | string }
  | { t: 'phase'; phase: VoicePhase }
  | { t: 'partial'; text: string }
  | { t: 'final'; turnId: string; text: string }
  | { t: 'turn'; turnId: string; state: VoiceTurnState; error?: string }
  | { t: 'reply'; turnId: string; delta: string }
  | { t: 'speech'; gen: number; state: VoiceSpeechState }
  | { t: 'level'; v: number }
  | { t: 'approval'; turnId: string; summary: string }
  | { t: 'error'; code: string; message: string; fatal: boolean }
  | { t: 'ended'; reason: string };

export class VoiceProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceProtocolError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

function requireString(frame: Record<string, unknown>, field: string): string {
  const value = frame[field];
  if (typeof value !== 'string') throw new VoiceProtocolError(`${field} must be a string`);
  return value;
}

function requireNumber(frame: Record<string, unknown>, field: string): number {
  const value = frame[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new VoiceProtocolError(`${field} must be a finite number`);
  }
  return value;
}

function requireEnum<T extends string>(
  frame: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const value = frame[field];
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new VoiceProtocolError(`${field} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function toRecord(value: unknown, types: readonly string[]): Record<string, unknown> {
  let frame = value;
  if (typeof value === 'string') {
    if (utf8ByteLength(value) > MAX_FRAME_BYTES) throw new VoiceProtocolError('frame is too large');
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
  return frame;
}

export function parsePhoneFrame(value: unknown): PhoneVoiceFrame {
  const frame = toRecord(value, PHONE_FRAME_TYPES);
  switch (frame.t) {
    case 'mute':
      if (typeof frame.on !== 'boolean') throw new VoiceProtocolError('on must be a boolean');
      return { t: 'mute', on: frame.on };
    case 'skip':
      return { t: 'skip' };
    case 'bargein':
      return { t: 'bargein' };
    default:
      return { t: 'end' };
  }
}

export function parseGateFrame(value: unknown): GateVoiceFrame {
  const frame = toRecord(value, GATE_FRAME_TYPES);
  switch (frame.t) {
    case 'ready':
      return { t: 'ready', engine: requireString(frame, 'engine') };
    case 'phase':
      return { t: 'phase', phase: requireEnum(frame, 'phase', PHASES) };
    case 'partial':
      return { t: 'partial', text: requireString(frame, 'text') };
    case 'final':
      return { t: 'final', turnId: requireString(frame, 'turnId'), text: requireString(frame, 'text') };
    case 'turn': {
      const turn: Extract<GateVoiceFrame, { t: 'turn' }> = {
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
}

export function serializeFrame(frame: PhoneVoiceFrame | GateVoiceFrame): string {
  return JSON.stringify(frame);
}
