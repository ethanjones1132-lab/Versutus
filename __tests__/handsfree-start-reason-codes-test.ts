import { DeviceIdentityError, GatewayHttpError, isDeviceIdentityError } from '@/lib/gateway/errors';
import { handsfreeStartResultCopy } from '@/lib/voice/handsfree-call-copy';
import {
  openGateVoiceSession,
  type OpenGateVoiceSessionInput,
} from '@/lib/voice/handsfree-start-attempt';
import {
  HANDSFREE_START_FAILURES,
  evaluateHandsfreeStart,
  type HandsfreeStartEvaluation,
  type HandsfreeStartFailure,
} from '@/lib/voice/handsfree-start-reason';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

// Every way a hands-free start can fail has its own stable string. The bug was
// that a rejected native session, a service that answered `'unavailable'`, a
// transport error and an unexpected throw all looked the same to the operator.
// These cases drive the provider's own decision and start chain so each exit is
// pinned to the code the sheet and the log will show.

const readySpeech = { recognition: true, synthesis: true, maxSpeechInputLength: 4000 };
const noRecognition = { recognition: false, synthesis: true, maxSpeechInputLength: 4000 };
const noSynthesis = { recognition: true, synthesis: false, maxSpeechInputLength: 0 };

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

const target = {
  label: 'Untitled',
  voiceEngine: 'local',
  surfaceKind: 'bot' as const,
  sessionId: 's1',
  botId: 'hermes',
};

const grant = {
  voiceSessionId: 'vs-1',
  streamPath: '/v1/voice/stream',
  engine: 'local',
};

function gateStart(overrides: Partial<OpenGateVoiceSessionInput> = {}) {
  return openGateVoiceSession({
    gatewayUrl: 'http://127.0.0.1:8760',
    gatewayToken: 'tok',
    target,
    device: { deviceId: 'phone-abc12345' },
    gatewayRequest: async (method) => (method === 'voice.session.start' ? grant : { stopped: true }),
    startGateMedia: async () => true,
    startTimeoutMs: 5_000,
    log: () => undefined,
    ...overrides,
  });
}

async function chainResult(overrides: Partial<OpenGateVoiceSessionInput>): Promise<HandsfreeStartFailure> {
  const attempt = await gateStart(overrides);
  expect(attempt.result).not.toBe('started');
  return attempt.result as HandsfreeStartFailure;
}

function decision(overrides: Partial<HandsfreeStartEvaluation>): HandsfreeStartFailure {
  const evaluated = evaluateHandsfreeStart({ ...connected, ...overrides });
  if (evaluated.kind !== 'stop') throw new Error('expected the start to be refused');
  return evaluated.result;
}

function gateRefusal(code: string): () => Promise<unknown> {
  return async () => {
    throw new GatewayHttpError(`refused: ${code}`, 409, code);
  };
}

/**
 * One case per failure code the provider decision or start chain can produce.
 * The two structural codes (a call torn down while starting, an unexpected
 * throw) are pinned separately below because neither is a mapping.
 */
type ChainCode = Exclude<
  HandsfreeStartFailure,
  'call-torn-down-while-starting' | 'start-failed-unexpectedly'
>;

const DRIVERS: Record<ChainCode, () => Promise<HandsfreeStartFailure>> = {
  // The provider's pure decision.
  refused: async () => decision({ phase: 'listening' }),
  'no-native-module': async () => decision({ moduleLoaded: false }),
  'availability-unreadable': async () => decision({ availabilityError: true }),
  'phone-recognition-unavailable': async () => decision({ availability: noRecognition }),
  'phone-synthesis-unavailable': async () => decision({ availability: noSynthesis }),
  'no-gateway-url': async () => decision({ transport: 'gate', gatewayUrl: '' }),
  'no-session': async () => decision({ transport: 'gate', sessionId: '' }),

  // The device identity read, before the Gate is asked for anything. This is the
  // same predicate the provider uses to choose between the two codes.
  'identity-unavailable': async () => (isDeviceIdentityError(new DeviceIdentityError())
    ? 'identity-unavailable'
    : 'device-params-failed'),
  'device-params-failed': async () => (isDeviceIdentityError(new Error('secure store unavailable'))
    ? 'identity-unavailable'
    : 'device-params-failed'),

  // A Gate refusal or transport error.
  'not-paired': async () => chainResult({ gatewayRequest: gateRefusal('pairing_required') }),
  'call-in-progress': async () => chainResult({ gatewayRequest: gateRefusal('call_in_progress') }),
  'no-engine': async () => chainResult({ gatewayRequest: gateRefusal('no_engine') }),
  // A plaintext socket to a host off this machine: refused before the Gate is
  // asked for a session at all (S1, D2).
  'insecure-media-url': async () => chainResult({ gatewayUrl: 'http://192.168.1.20:8760' }),
  'session-start-failed': async () => chainResult({
    gatewayRequest: async () => {
      throw new Error('Network request failed');
    },
  }),

  // The Gate opened something this phone cannot join.
  'session-grant-incomplete': async () => chainResult({
    gatewayRequest: async () => ({ voiceSessionId: 'vs-1' }),
  }),
  'media-start-failed': async () => chainResult({ startGateMedia: async () => false }),
  'start-timed-out': async () => chainResult({
    gatewayRequest: () => new Promise(() => {}),
    startTimeoutMs: 10,
  }),

  // The phone's own session.
  'permission-denied': async () => chainResult({
    startSession: async (): Promise<'permission-denied'> => 'permission-denied',
  }),
  'native-session-unavailable': async () => chainResult({
    startSession: async (): Promise<'unavailable'> => 'unavailable',
  }),
  'native-session-rejected': async () => chainResult({
    startSession: async () => {
      throw new Error('the native call service threw');
    },
  }),
};

const provider = readSource('src', 'context', 'handsfree-voice-provider.tsx');
const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');

/** Every sentence has to leave the operator with something to do. */
const ACTION = /try again|try reconnecting|start again|Start again|check|Check|Update|update|Allow|allow|Reconnect|reconnect|restart|Restart|End it|Send a message|run voice install|Run voice install|Stay on the same network/i;

describe('one distinct reason code per hands-free start failure path', () => {
  test.each(Object.keys(DRIVERS) as ChainCode[])(
    '%s is produced by its own path, not by a generic failure',
    async (code) => {
      await expect(DRIVERS[code]()).resolves.toBe(code);
    },
  );

  test('a rejected native start keeps the service error as its reason and does not claim unavailable', async () => {
    const attempt = await gateStart({
      startSession: async () => {
        throw new Error('the native call service threw');
      },
    });
    expect(attempt.result).toBe('native-session-rejected');
    expect(attempt.detail).toMatch(/the native call service threw/);
    expect(attempt.result).not.toBe('native-session-unavailable');
  });

  test('a native service that answers unavailable is a different failure from a rejection', async () => {
    const attempt = await gateStart({
      startSession: async (): Promise<'unavailable'> => 'unavailable',
    });
    expect(attempt.result).toBe('native-session-unavailable');
    if (attempt.result === 'started') throw new Error('expected the native service refusal');
    expect(handsfreeStartResultCopy(attempt.result)).not.toBe(
      handsfreeStartResultCopy('native-session-rejected'),
    );
  });

  test('a transport error names the PC, never this phone’s speech service', async () => {
    const attempt = await gateStart({
      gatewayRequest: async () => {
        throw new Error('Network request failed');
      },
    });
    expect(attempt.result).toBe('session-start-failed');
    if (attempt.result === 'started') throw new Error('expected the transport failure');
    const line = handsfreeStartResultCopy(attempt.result, { transport: 'gate', engine: 'local' });
    expect(line).toMatch(/connection/i);
    expect(line).not.toMatch(/speech recognition/i);
  });

  test('the retired generic unavailable code is gone from the union', () => {
    expect(HANDSFREE_START_FAILURES).not.toContain('unavailable');
  });

  test('every failure has one sentence and says what to do next', () => {
    const lines = HANDSFREE_START_FAILURES.map((code) => handsfreeStartResultCopy(code));
    expect(lines.every((line) => line.length > 0)).toBe(true);
    expect(new Set(lines).size).toBe(HANDSFREE_START_FAILURES.length);
    for (const line of lines) expect(line).toMatch(ACTION);
  });
});

describe('the structural start failures name themselves too', () => {
  test('a call torn down while starting says to start again', () => {
    expect(provider).toContain("result: 'call-torn-down-while-starting'");
    expect(handsfreeStartResultCopy('call-torn-down-while-starting')).toMatch(/start again/i);
  });

  test('an unexpected throw is reported as unexpected, not as an unavailable service', () => {
    // The start body moved into the shared startCallWith (slice 7: consent can skip the sheet).
    const at = screen.indexOf('const startCallWith = useCallback(');
    const handler = screen.slice(at, screen.indexOf('}, [activeGateway, botVoice', at));
    const catchBlock = handler.slice(handler.indexOf('} catch'));
    expect(catchBlock).toContain("handsfreeStartResultCopy('start-failed-unexpectedly'");
    expect(catchBlock).not.toContain("handsfreeStartResultCopy('unavailable'");
    expect(handsfreeStartResultCopy('start-failed-unexpectedly')).toMatch(/unexpected/i);
    expect(handsfreeStartResultCopy('start-failed-unexpectedly')).toMatch(/try again/i);
  });
});
