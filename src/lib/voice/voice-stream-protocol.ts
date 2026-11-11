// ─── The phone side of the Gate media protocol ───────────────────────────
// The mirror of `gate/core/voice/protocol.mjs`. Both read the one fixture at
// `gate/__tests__/fixtures/voice-protocol.json`, so a frame added on one side
// without the other fails a test rather than a call.

export const MAX_FRAME_BYTES = 4096;

export const PHONE_FRAME_TYPES = ['mute', 'skip', 'bargein', 'end', 'played'] as const;
export const GATE_FRAME_TYPES = [
  'call',
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
export const PHASES = ['opening', 'listening', 'thinking', 'speaking', 'muted'] as const;
export const TURN_STATES = ['sent', 'replying', 'done', 'failed'] as const;
export const SPEECH_STATES = ['start', 'end', 'cancelled', 'gap'] as const;

export type VoicePhase = (typeof PHASES)[number];
export type VoiceTurnState = (typeof TURN_STATES)[number];
export type VoiceSpeechState = (typeof SPEECH_STATES)[number];
export type VoiceEngineId = 'local' | 'codex' | 'phone';
export type VoiceV2Envelope = { v: 2; callId: string; seq: number; ts: number };

export type PhoneVoiceFrame = (
  | { t: 'mute'; on: boolean }
  | { t: 'skip' }
  | { t: 'bargein' }
  | { t: 'end' }
  | { t: 'played'; gen: number; atMs: number }) & Partial<VoiceV2Envelope>;

export type GateVoiceFrame = (
  | { t: 'call'; state: 'opening' | 'ready' | 'ending' | 'ended' }
  | { t: 'ready'; engine: VoiceEngineId | string; resumeWindowMs?: number }
  | { t: 'phase'; phase: VoicePhase }
  | { t: 'partial'; text: string }
  | { t: 'final'; turnId: string; text: string }
  | { t: 'turn'; turnId: string; state: VoiceTurnState; error?: string }
  | { t: 'reply'; turnId: string; delta: string }
  | { t: 'speech'; gen: number; state: VoiceSpeechState }
  | {
      t: 'approval';
      turnId: string;
      summary: string;
      approvalId?: string;
      state?: 'pending' | 'approved' | 'denied' | 'expired';
    }
  | { t: 'error'; code: string; message: string; fatal: boolean }
  | { t: 'ended'; reason: string }) & Partial<VoiceV2Envelope>
  | { t: 'level'; v: number }
  | ({ t: 'level'; level: number } & VoiceV2Envelope);

export class VoiceProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceProtocolError';
  }
}

function parseEnvelope(frame: Record<string, unknown>, expectedCallId?: string): VoiceV2Envelope | null {
  if (frame.v === undefined) return null;
  if (frame.v !== 2) throw new VoiceProtocolError(`unsupported protocol version: ${String(frame.v)}`);
  if (typeof frame.callId !== 'string' || !frame.callId) throw new VoiceProtocolError('callId must be a non-empty string');
  if (expectedCallId !== undefined && frame.callId !== expectedCallId) throw new VoiceProtocolError('callId does not match this call');
  if (!Number.isSafeInteger(frame.seq) || (frame.seq as number) <= 0) throw new VoiceProtocolError('seq must be a positive integer');
  if (typeof frame.ts !== 'number' || !Number.isFinite(frame.ts) || frame.ts < 0) {
    throw new VoiceProtocolError('ts must be a non-negative finite number');
  }
  return { v: 2, callId: frame.callId, seq: frame.seq as number, ts: frame.ts };
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

export function parsePhoneFrame(value: unknown, options: { callId?: string } = {}): PhoneVoiceFrame {
  const frame = toRecord(value, PHONE_FRAME_TYPES);
  const envelope = parseEnvelope(frame, options.callId);
  const withEnvelope = <T extends PhoneVoiceFrame>(parsed: T): T => ({ ...parsed, ...(envelope ?? {}) }) as T;
  switch (frame.t) {
    case 'mute':
      if (typeof frame.on !== 'boolean') throw new VoiceProtocolError('on must be a boolean');
      return withEnvelope({ t: 'mute', on: frame.on });
    case 'skip':
      return withEnvelope({ t: 'skip' });
    case 'bargein':
      return withEnvelope({ t: 'bargein' });
    case 'played':
      return withEnvelope({ t: 'played', gen: requireNumber(frame, 'gen'), atMs: requireNumber(frame, 'atMs') });
    default:
      return withEnvelope({ t: 'end' });
  }
}

export function parseGateFrame(value: unknown, options: { callId?: string } = {}): GateVoiceFrame {
  const frame = toRecord(value, GATE_FRAME_TYPES);
  if (frame.t === 'call' && frame.v !== 2) throw new VoiceProtocolError('call frames require protocol version 2');
  // `v` is the existing v1 level payload. V2 levels use `level` for the
  // payload so the envelope can keep `v: 2` without colliding with it.
  const isLegacyLevel = frame.t === 'level' && frame.level === undefined && frame.callId === undefined && frame.seq === undefined && frame.ts === undefined;
  const envelope = isLegacyLevel ? null : parseEnvelope(frame, options.callId);
  const withEnvelope = <T extends GateVoiceFrame>(parsed: T): T => ({ ...parsed, ...(envelope ?? {}) }) as T;
  switch (frame.t) {
    case 'call':
      return withEnvelope({ t: 'call', state: requireEnum(frame, 'state', ['opening', 'ready', 'ending', 'ended']) });
    case 'ready': {
      const ready: Extract<GateVoiceFrame, { t: 'ready' }> = {
        t: 'ready',
        engine: requireString(frame, 'engine'),
      };
      // How long the Gate will hold the call for without a phone, so the app
      // can match its own re-connect budget to it. Optional: a Gate that does
      // not send it is an older Gate, and the app falls back to its own window.
      if (frame.resumeWindowMs !== undefined) {
        ready.resumeWindowMs = requireNumber(frame, 'resumeWindowMs');
      }
      return withEnvelope(ready);
    }
    case 'phase':
      return withEnvelope({ t: 'phase', phase: requireEnum(frame, 'phase', PHASES) });
    case 'partial':
      return withEnvelope({ t: 'partial', text: requireString(frame, 'text') });
    case 'final':
      return withEnvelope({ t: 'final', turnId: requireString(frame, 'turnId'), text: requireString(frame, 'text') });
    case 'turn': {
      const turn: Extract<GateVoiceFrame, { t: 'turn' }> = {
        t: 'turn',
        turnId: requireString(frame, 'turnId'),
        state: requireEnum(frame, 'state', TURN_STATES),
      };
      if (frame.error !== undefined) turn.error = requireString(frame, 'error');
      return withEnvelope(turn);
    }
    case 'reply':
      return withEnvelope({ t: 'reply', turnId: requireString(frame, 'turnId'), delta: requireString(frame, 'delta') });
    case 'speech':
      return withEnvelope({ t: 'speech', gen: requireNumber(frame, 'gen'), state: requireEnum(frame, 'state', SPEECH_STATES) });
    case 'level':
      if (envelope) return { t: 'level', level: requireNumber(frame, 'level'), ...envelope };
      return { t: 'level', v: requireNumber(frame, 'v') };
    case 'approval': {
      const approval: Extract<GateVoiceFrame, { t: 'approval' }> = {
        t: 'approval',
        turnId: requireString(frame, 'turnId'),
        summary: requireString(frame, 'summary'),
      };
      if (frame.approvalId !== undefined) approval.approvalId = requireString(frame, 'approvalId');
      if (frame.state !== undefined) {
        approval.state = requireEnum(frame, 'state', ['pending', 'approved', 'denied', 'expired']) as
          'pending' | 'approved' | 'denied' | 'expired';
      }
      return withEnvelope(approval);
    }
    case 'error':
      if (typeof frame.fatal !== 'boolean') throw new VoiceProtocolError('fatal must be a boolean');
      return withEnvelope({
        t: 'error',
        code: requireString(frame, 'code'),
        message: requireString(frame, 'message'),
        fatal: frame.fatal,
      });
    default:
      return withEnvelope({ t: 'ended', reason: requireString(frame, 'reason') });
  }
}

export function serializeFrame(frame: PhoneVoiceFrame | GateVoiceFrame): string {
  return JSON.stringify(frame);
}

/** A requested v2 link is selected only by an envelope; legacy attach frames confirm fallback. */
export function protocolForFirstGateFrame(value: unknown): 1 | 2 | null {
  let frame: GateVoiceFrame;
  try {
    frame = parseGateFrame(value);
  } catch {
    return null;
  }
  if (frame.v === 2) return 2;
  return frame.t === 'ready' || frame.t === 'phase' ? 1 : null;
}
