// ─── Why a hands-free call did not start ─────────────────────────────────
// About ten different failures used to collapse into one `'unavailable'`, and
// the sheet always blamed this phone's speech recognizer — even when the
// operator had chosen the PC engine and the phone never reached the Gate.
// Each exit has its own code so a failed start is diagnosable from the sheet,
// the phone log, and gate.log.

import type { VoiceEnginePreference } from '@/lib/voice/voice-engine-choice';

export type HandsfreeStartTransport = 'phone' | 'gate';

/**
 * The one transport decision. The stored preference names an engine, but the
 * resolved choice can still fall back to the phone; the Call offer and the
 * start path must both follow the resolved engine, never the raw preference.
 * While the resolved choice is unknown, a non-phone preference stays on the
 * Gate: that is the only side that can start without this phone's speech.
 */
export function handsfreeTransportForCall(
  engine: string | undefined,
  preference: VoiceEnginePreference | undefined,
): HandsfreeStartTransport {
  if (preference === 'phone') return 'phone';
  if (engine === 'phone') return 'phone';
  return 'gate';
}

/**
 * Whether the Gate's one voice switch permits an offer at all (S7/D7). A
 * disabled Gate means no call on any engine from that gateway — the phone
 * engine is not a fallback the switch says nothing about. Only an explicit
 * `false` switches calls off; an absent answer is not guessed into one.
 */
export function handsfreeCallsOffered(
  capabilities: { enabled?: boolean } | null | undefined,
): boolean {
  return capabilities?.enabled !== false;
}

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
  | 'insecure-media-url'
  | 'session-start-failed'
  | 'session-grant-incomplete'
  | 'media-start-failed'
  | 'start-timed-out'
  | 'call-torn-down-while-starting'
  | 'native-session-unavailable'
  | 'native-session-rejected'
  | 'start-failed-unexpectedly';

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
  'insecure-media-url',
  'session-start-failed',
  'session-grant-incomplete',
  'media-start-failed',
  'start-timed-out',
  'call-torn-down-while-starting',
  'native-session-unavailable',
  'native-session-rejected',
  'start-failed-unexpectedly',
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

/** Whether the selected transport has the device support needed to offer Call. */
export function handsfreeDeviceCanOfferCall(
  availability: HandsfreeStartAvailability | null,
): boolean;
export function handsfreeDeviceCanOfferCall(
  availability: HandsfreeStartAvailability | null,
  moduleLoaded: boolean,
  transport: HandsfreeStartTransport,
  callsEnabled?: boolean,
): boolean;
export function handsfreeDeviceCanOfferCall(
  availability: HandsfreeStartAvailability | null,
  moduleLoaded?: boolean,
  transport?: HandsfreeStartTransport,
  callsEnabled?: boolean,
): boolean {
  // Keep the original probe-only call shape for existing consumers: a
  // successful availability response proves the module answered. The provider
  // uses the explicit form below so an unreadable phone probe can still offer
  // a Gate call without mistaking a missing native module for readiness.
  if (moduleLoaded === undefined || transport === undefined) return availability !== null;
  // The Gate switch is the first thing it says, and it outranks both device
  // support and the transport: "off" means there is no call to offer (S7).
  if (callsEnabled === false) return false;
  if (!moduleLoaded) return false;
  if (transport === 'gate') return true;
  return phoneSpeechBlocker(availability) === null;
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

  if (input.transport === 'gate') {
    // The Gate runs STT/TTS: an unreadable on-device availability is irrelevant
    // here and must not block a PC-powered call. The native module itself is
    // still required — it owns the media socket and the foreground session.
    if (!input.gatewayUrl) return { kind: 'stop', result: 'no-gateway-url' };
    if (!input.sessionId) return { kind: 'stop', result: 'no-session' };
    return { kind: 'gate' };
  }

  if (input.availabilityError) return { kind: 'stop', result: 'availability-unreadable' };
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

/**
 * Map the phone-native start answer. A rejection is not the service answering
 * `'unavailable'`: one never produced an answer at all. They leave the operator
 * with different things to try, so they must not share a code.
 */
export function mapNativeSessionStartFailure(
  outcome: 'permission-denied' | 'unavailable',
  rejected = false,
  rejection?: unknown,
): { result: HandsfreeStartFailure; detail?: string } {
  if (outcome === 'permission-denied') return { result: 'permission-denied' };
  if (rejected) {
    return {
      result: 'native-session-rejected',
      detail: errorMessage(rejection === undefined ? 'the native start was rejected' : rejection),
    };
  }
  return { result: 'native-session-unavailable' };
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

// ─── Call consent, remembered per engine and transport ───────────────────
// D5: the disclosure is owed on the first call per engine AND transport, then
// the Call control is one tap. The key names both, so moving from the PC to
// the phone, or from local to Codex, asks again; a repeat call on the same
// pair does not. Only an explicit `true` is consent, so a truncated, edited or
// older blob can only ever ask again — never skip the disclosure.

export const HANDSFREE_CONSENT_STORAGE_KEY = 'versutus:handsfree-call-consent';

export type HandsfreeCallConsentStore = Record<string, true>;

/** The one key a call's consent is stored under: who drove it, and on what. */
export function handsfreeConsentKey(engine: string, transport: HandsfreeStartTransport): string {
  return `${transport}:${engine}`;
}

/** Read a stored blob. Anything that is not the literal `true` is not consent. */
export function handsfreeConsentStoreFromUnknown(value: unknown): HandsfreeCallConsentStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const store: HandsfreeCallConsentStore = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === true) store[key] = true;
  }
  return store;
}

export function hasHandsfreeConsent(
  store: HandsfreeCallConsentStore,
  key: string,
): boolean {
  return store[key] === true;
}

/** Record one engine+transport pair, leaving every other pair's consent alone. */
export function grantHandsfreeConsent(
  store: HandsfreeCallConsentStore,
  key: string,
): HandsfreeCallConsentStore {
  if (store[key] === true) return store;
  return { ...store, [key]: true };
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
