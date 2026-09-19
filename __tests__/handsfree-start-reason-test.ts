import { GatewayHttpError } from '@/lib/gateway/errors';
import { handsfreeStartResultCopy } from '@/lib/voice/handsfree-call-copy';
import {
  HANDSFREE_START_FAILURES,
  evaluateHandsfreeStart,
  handsfreeDeviceCanOfferCall,
  mapGateSessionStartFailure,
  parseVoiceSessionGrant,
  phoneSpeechBlocker,
  type HandsfreeStartEvaluation,
} from '@/lib/voice/handsfree-start-reason';

const readySpeech = { recognition: true, synthesis: true, maxSpeechInputLength: 4000 };
const noSpeech = { recognition: false, synthesis: true, maxSpeechInputLength: 4000 };

const connected: HandsfreeStartEvaluation = {
  phase: 'idle',
  appState: 'active',
  status: 'connected',
  gatewayId: 'gw-1',
  targetGatewayId: 'gw-1',
  isSending: false,
  isCommandRunning: false,
  pendingRunApproval: false,
  moduleLoaded: true,
  availability: readySpeech,
  transport: 'phone',
  gatewayUrl: 'http://gate.local:8760',
  sessionId: 's1',
};

describe('evaluateHandsfreeStart', () => {
  test('a connected idle phone with speech continues on the phone path', () => {
    expect(evaluateHandsfreeStart(connected)).toEqual({ kind: 'phone' });
  });

  test('a Gate call continues without this phone’s speech recognizer', () => {
    expect(
      evaluateHandsfreeStart({
        ...connected,
        transport: 'gate',
        availability: noSpeech,
      }),
    ).toEqual({ kind: 'gate' });
  });

  test('a Gate call with no speech still continues when availability is missing', () => {
    expect(
      evaluateHandsfreeStart({
        ...connected,
        transport: 'gate',
        availability: null,
      }),
    ).toEqual({ kind: 'gate' });
  });

  test('a Gate call continues when the availability read itself fails', () => {
    // The PC engine never asks this phone for speech; an unreadable
    // availability must not take a PC-powered call down with it.
    expect(
      evaluateHandsfreeStart({
        ...connected,
        transport: 'gate',
        availability: null,
        availabilityError: true,
      }),
    ).toEqual({ kind: 'gate' });
  });

  test('names each precondition instead of collapsing to unavailable', () => {
    expect(evaluateHandsfreeStart({ ...connected, phase: 'listening' })).toEqual({
      kind: 'stop',
      result: 'refused',
    });
    expect(evaluateHandsfreeStart({ ...connected, appState: 'background' })).toEqual({
      kind: 'stop',
      result: 'refused',
    });
    expect(evaluateHandsfreeStart({ ...connected, status: 'reconnecting' })).toEqual({
      kind: 'stop',
      result: 'refused',
    });
    expect(evaluateHandsfreeStart({ ...connected, targetGatewayId: 'other' })).toEqual({
      kind: 'stop',
      result: 'refused',
    });
    expect(evaluateHandsfreeStart({ ...connected, isSending: true })).toEqual({
      kind: 'stop',
      result: 'refused',
    });
    expect(evaluateHandsfreeStart({ ...connected, moduleLoaded: false })).toEqual({
      kind: 'stop',
      result: 'no-native-module',
    });
    expect(evaluateHandsfreeStart({ ...connected, availabilityError: true })).toEqual({
      kind: 'stop',
      result: 'availability-unreadable',
    });
    expect(evaluateHandsfreeStart({ ...connected, availability: noSpeech })).toEqual({
      kind: 'stop',
      result: 'phone-recognition-unavailable',
    });
    expect(
      evaluateHandsfreeStart({
        ...connected,
        availability: { recognition: true, synthesis: false, maxSpeechInputLength: 0 },
      }),
    ).toEqual({ kind: 'stop', result: 'phone-synthesis-unavailable' });
    expect(
      evaluateHandsfreeStart({ ...connected, transport: 'gate', gatewayUrl: '' }),
    ).toEqual({ kind: 'stop', result: 'no-gateway-url' });
    expect(
      evaluateHandsfreeStart({ ...connected, transport: 'gate', sessionId: '' }),
    ).toEqual({ kind: 'stop', result: 'no-session' });
  });
});

describe('phoneSpeechBlocker and Call offering', () => {
  test('Call is offered once the native module answers, even without a recognizer', () => {
    expect(handsfreeDeviceCanOfferCall(null)).toBe(false);
    expect(handsfreeDeviceCanOfferCall(noSpeech)).toBe(true);
    expect(handsfreeDeviceCanOfferCall(readySpeech)).toBe(true);
  });

  test('the on-device engine still needs recognition and synthesis', () => {
    expect(phoneSpeechBlocker(null)).toBe('availability-unreadable');
    expect(phoneSpeechBlocker(noSpeech)).toBe('phone-recognition-unavailable');
    expect(phoneSpeechBlocker(readySpeech)).toBeNull();
  });
});

describe('mapGateSessionStartFailure', () => {
  test('names the Gate’s own refusal codes', () => {
    expect(mapGateSessionStartFailure(Object.assign(new Error('thread must name a session'), { code: 'invalid_request' })).result).toBe('no-session');
    expect(mapGateSessionStartFailure(Object.assign(new Error('This device already has a live voice call'), { code: 'call_in_progress' })).result).toBe('call-in-progress');
    expect(mapGateSessionStartFailure(Object.assign(new Error('The PC voice models are not installed.'), { code: 'no_engine' })).result).toBe('no-engine');
    expect(mapGateSessionStartFailure(Object.assign(new Error('a paired device grant is required'), { code: 'pairing_required' })).result).toBe('not-paired');
    expect(mapGateSessionStartFailure(new Error('boom')).result).toBe('session-start-failed');
  });

  test('falls back to the message when the HTTP layer dropped the code', () => {
    expect(mapGateSessionStartFailure(new Error('thread must name a session')).result).toBe('no-session');
    expect(mapGateSessionStartFailure(new Error('This device already has a live voice call')).result).toBe('call-in-progress');
  });

  test('reads the Gate’s code off a GatewayHttpError', () => {
    expect(
      mapGateSessionStartFailure(
        new GatewayHttpError('The PC voice models are not installed.', 409, 'no_engine'),
      ).result,
    ).toBe('no-engine');
  });
});

describe('parseVoiceSessionGrant', () => {
  test('keeps a complete grant and refuses an incomplete one', () => {
    expect(
      parseVoiceSessionGrant({
        voiceSessionId: 'vs-1',
        streamPath: '/v1/voice/stream',
        engine: 'local',
      }),
    ).toEqual({ voiceSessionId: 'vs-1', streamPath: '/v1/voice/stream', engine: 'local' });
    expect(parseVoiceSessionGrant({ voiceSessionId: 'vs-1' })).toBeNull();
    expect(parseVoiceSessionGrant(null)).toBeNull();
    expect(parseVoiceSessionGrant('vs-1')).toBeNull();
  });
});

describe('handsfreeStartResultCopy', () => {
  test('every named failure has its own sentence', () => {
    const lines = HANDSFREE_START_FAILURES.map((reason) => handsfreeStartResultCopy(reason));
    expect(lines.every((line) => line.length > 0)).toBe(true);
    expect(new Set(lines).size).toBe(HANDSFREE_START_FAILURES.length);
  });

  test('a PC-engine failure never tells the operator to install a phone recognizer', () => {
    const pcReasons = [
      'no-gateway-url',
      'no-session',
      'no-engine',
      'session-start-failed',
      'session-grant-incomplete',
      'media-start-failed',
      'call-in-progress',
      'not-paired',
      'unavailable',
    ] as const;
    for (const reason of pcReasons) {
      const line = handsfreeStartResultCopy(reason, { transport: 'gate', engine: 'local' });
      expect(line).not.toMatch(/speech recognition/i);
    }
  });

  test('only the on-device recognizer failure mentions a speech recognition service', () => {
    expect(handsfreeStartResultCopy('phone-recognition-unavailable')).toMatch(/speech recognition service/);
    expect(handsfreeStartResultCopy('unavailable', { transport: 'phone' })).not.toMatch(/speech recognition/i);
  });

  test('carries the Gate’s own reason when it named one', () => {
    expect(
      handsfreeStartResultCopy('no-engine', {
        detail: 'The PC voice models are not installed. Run voice install on the Gate.',
      }),
    ).toMatch(/Run voice install on the Gate/);
  });
});
