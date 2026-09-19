// ─── Why a hands-free call did not start ─────────────────────────────────
// About ten different failures used to collapse into one `'unavailable'`, and
// the sheet always blamed this phone's speech recognizer — even when the
// operator had chosen the PC engine and the phone never reached the Gate.
// Each exit has its own code so a failed start is diagnosable from the sheet,
// the phone log, and gate.log.

export type HandsfreeStartTransport = 'phone' | 'gate';

/** What `getAvailability` reports, without taking a dependency on the native module. */
export type HandsfreeStartAvailability = {
  recognition: boolean;
  synthesis: boolean;
  maxSpeechInputLength: number;
};

/**
 * Every way `start` can resolve. `'started'` is success; `'refused'` is a
 * precondition the sheet should have blocked; the rest are named failures.
 */
export type HandsfreeStartResult =
  | 'started'
  | 'refused'
  | 'permission-denied'
  | 'identity-unavailable'
  | 'no-native-module'
  | 'availability-unreadable'
  | 'phone-recognition-unavailable'
  | 'phone-synthesis-unavailable'
  | 'no-gateway-url'
  | 'device-params-failed'
  | 'no-session'
  | 'not-paired'
  | 'call-in-progress'
  | 'no-engine'
  | 'session-start-failed'
  | 'session-grant-incomplete'
  | 'media-start-failed'
  | 'call-torn-down-while-starting'
  | 'native-session-unavailable'
  | 'unavailable';

export type HandsfreeStartFailure = Exclude<HandsfreeStartResult, 'started'>;

export type HandsfreeStartAttempt = {
  result: HandsfreeStartResult;
  detail?: string;
};

export type HandsfreeStartCopyContext = {
  transport?: HandsfreeStartTransport;
  engine?: string;
  detail?: string;
};

export type HandsfreeStartLog = {
  result: HandsfreeStartResult;
  transport?: HandsfreeStartTransport;
  engine?: string;
  detail?: string;
};

export const HANDSFREE_START_FAILURES: readonly HandsfreeStartFailure[] = [
  'refused',
  'permission-denied',
  'identity-unavailable',
  'no-native-module',
  'availability-unreadable',
  'phone-recognition-unavailable',
  'phone-synthesis-unavailable',
  'no-gateway-url',
  'device-params-failed',
  'no-session',
  'not-paired',
  'call-in-progress',
  'no-engine',
  'session-start-failed',
  'session-grant-incomplete',
  'media-start-failed',
  'call-torn-down-while-starting',
  'native-session-unavailable',
  'unavailable',
];

export type HandsfreeStartEvaluation = {
  phase: string;
  appState: string;
  status: string;
  gatewayId?: string;
  targetGatewayId: string;
  isSending: boolean;
  isCommandRunning: boolean;
  pendingRunApproval: boolean;
  moduleLoaded: boolean;
  availability: HandsfreeStartAvailability | null;
  availabilityError?: boolean;
  transport: HandsfreeStartTransport;
  gatewayUrl?: string;
  sessionId: string;
};

export type HandsfreeStartDecision =
  | { kind: 'stop'; result: HandsfreeStartFailure; detail?: string }
  | { kind: 'phone' }
  | { kind: 'gate' };

/** The native module answered, so Call can be offered — PC voice does not need on-device speech. */
export function handsfreeDeviceCanOfferCall(
  availability: HandsfreeStartAvailability | null,
): boolean {
  return availability !== null;
}

/** What blocks an on-device (phone-engine) call, or null when speech is ready. */
export function phoneSpeechBlocker(
  availability: HandsfreeStartAvailability | null,
): 'availability-unreadable' | 'phone-recognition-unavailable' | 'phone-synthesis-unavailable' | null {
  if (!availability) return 'availability-unreadable';
  if (!availability.recognition) return 'phone-recognition-unavailable';
  if (!availability.synthesis || !(availability.maxSpeechInputLength > 0)) {
    return 'phone-synthesis-unavailable';
  }
  return null;
}

/**
 * The pure start decision. A Gate-powered call does not need this phone's
 * speech recognizer or TTS: the host runs STT/TTS and the phone is the
 * microphone and speaker. The on-device engine still does.
 */
export function evaluateHandsfreeStart(input: HandsfreeStartEvaluation): HandsfreeStartDecision {
  if (input.phase !== 'idle') return { kind: 'stop', result: 'refused' };
  if (input.appState !== 'active') return { kind: 'stop', result: 'refused' };
  if (input.status !== 'connected' || !input.gatewayId) return { kind: 'stop', result: 'refused' };
  if (input.gatewayId !== input.targetGatewayId) return { kind: 'stop', result: 'refused' };
  if (input.isSending || input.isCommandRunning || input.pendingRunApproval) {
    return { kind: 'stop', result: 'refused' };
  }
  if (!input.moduleLoaded) return { kind: 'stop', result: 'no-native-module' };
  if (input.availabilityError) return { kind: 'stop', result: 'availability-unreadable' };

  if (input.transport === 'gate') {
    if (!input.gatewayUrl) return { kind: 'stop', result: 'no-gateway-url' };
    if (!input.sessionId) return { kind: 'stop', result: 'no-session' };
    return { kind: 'gate' };
  }

  const speech = phoneSpeechBlocker(input.availability);
  if (speech) return { kind: 'stop', result: speech };
  return { kind: 'phone' };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' && code.trim() ? code.trim() : undefined;
}

/** Map a thrown `voice.session.start` into a named reason. */
export function mapGateSessionStartFailure(error: unknown): {
  result: HandsfreeStartFailure;
  detail: string;
} {
  const detail = errorMessage(error);
  const code = errorCode(error);
  if (code === 'invalid_request' || /thread must name a session/i.test(detail)) {
    return { result: 'no-session', detail };
  }
  if (code === 'call_in_progress' || /already has a live voice call/i.test(detail)) {
    return { result: 'call-in-progress', detail };
  }
  if (code === 'no_engine' || /not installed|not ready|No PC voice/i.test(detail)) {
    return { result: 'no-engine', detail };
  }
  if (
    code === 'pairing_required'
    || /paired device|pairing_required|pairing required/i.test(detail)
  ) {
    return { result: 'not-paired', detail };
  }
  return { result: 'session-start-failed', detail };
}

export type GateVoiceGrant = {
  voiceSessionId: string;
  streamPath: string;
  engine?: string;
  fellBackFrom?: string;
  reason?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readGrantField(record: Record<string, unknown>, key: string): string | undefined {
  const field = record[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

/** A `voice.session.start` result is only a grant when it names the session and the stream. */
export function parseVoiceSessionGrant(value: unknown): GateVoiceGrant | null {
  if (!isRecord(value)) return null;
  const voiceSessionId = readGrantField(value, 'voiceSessionId');
  const streamPath = readGrantField(value, 'streamPath');
  if (!voiceSessionId || !streamPath) return null;
  const grant: GateVoiceGrant = { voiceSessionId, streamPath };
  const engine = readGrantField(value, 'engine');
  const fellBackFrom = readGrantField(value, 'fellBackFrom');
  const reason = readGrantField(value, 'reason');
  if (engine) grant.engine = engine;
  if (fellBackFrom) grant.fellBackFrom = fellBackFrom;
  if (reason) grant.reason = reason;
  return grant;
}

/** One line on the phone console so a failed start is greppable in logcat. */
export function logHandsfreeStart(event: HandsfreeStartLog): void {
  const parts = [
    '[handsfree-start]',
    event.result,
    event.transport ? `transport=${event.transport}` : undefined,
    event.engine ? `engine=${event.engine}` : undefined,
    event.detail,
  ].filter((part): part is string => Boolean(part));
  console.warn(parts.join(' '));
}
