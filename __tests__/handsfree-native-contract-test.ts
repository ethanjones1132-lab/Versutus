// The native hands-free contract, pinned across the language boundary.
//
// Step 1 declares a set of events and methods in TypeScript; Steps 2–3 declare
// the same events in Kotlin and Swift and wire the methods. Nothing else in the
// build connects those three lists, so an event declared in TS and never
// registered natively (or a native method the TS contract never names) is
// exactly the "declared but never wired" class of defect this plan was
// corrected for. This test reads all three sources and asserts they agree.

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

const EVENTS = [
  'partial',
  'final',
  'noSpeech',
  'speechFinished',
  'interruption',
  'endRequested',
  'fatalError',
  'bargeIn',
  'level',
  'gate',
] as const;

const METHODS = [
  'getAvailability',
  'startSession',
  'startListening',
  'stopListening',
  'speak',
  'stopSpeaking',
  'setMuted',
  'playSendEarcon',
  'stopSession',
  'startGateMedia',
  'sendGateControl',
  'stopGateMedia',
  'verifyLaunch',
] as const;

const types = readSource('modules', 'handsfree-voice', 'src', 'HandsfreeVoice.types.ts');
const tsModule = readSource('modules', 'handsfree-voice', 'src', 'HandsfreeVoiceModule.ts');
const kotlin = readSource(
  'modules',
  'handsfree-voice',
  'android',
  'src',
  'main',
  'java',
  'com',
  'versutus',
  'handsfreevoice',
  'HandsfreeVoiceModule.kt',
);
const service = readSource(
  'modules',
  'handsfree-voice',
  'android',
  'src',
  'main',
  'java',
  'com',
  'versutus',
  'handsfreevoice',
  'HandsfreeCallService.kt',
);
const swift = readSource('modules', 'handsfree-voice', 'ios', 'HandsfreeVoiceModule.swift');
const gateMedia = readSource(
  'modules',
  'handsfree-voice',
  'android',
  'src',
  'main',
  'java',
  'com',
  'versutus',
  'handsfreevoice',
  'HandsfreeGateMedia.kt',
);

describe('hands-free native contract', () => {
  it('declares every event in the TypeScript contract', () => {
    for (const event of EVENTS) {
      expect(types).toContain(`${event}:`);
    }
  });

  it('registers every event natively on both platforms', () => {
    for (const event of EVENTS) {
      expect(kotlin).toContain(`"${event}"`);
      expect(swift).toContain(`"${event}"`);
    }
  });

  it('declares every method in the TypeScript contract', () => {
    for (const method of METHODS) {
      expect(tsModule).toContain(`${method}(`);
    }
  });

  it('wires every method natively on both platforms', () => {
    for (const method of METHODS) {
      expect(kotlin).toContain(`AsyncFunction("${method}")`);
      expect(swift).toContain(`AsyncFunction("${method}")`);
    }
  });

  it('emits the declared Android notification event from the service, not only declares it', () => {
    expect(service).toContain('emit("endRequested"');
  });

  it('emits every service-side event through the bridge', () => {
    for (const event of ['partial', 'final', 'noSpeech', 'speechFinished', 'interruption', 'fatalError', 'bargeIn', 'level']) {
      expect(service).toContain(`emit("${event}"`);
    }
  });

  it('emits the iOS service-side events through sendEvent', () => {
    for (const event of ['partial', 'final', 'noSpeech', 'speechFinished', 'interruption', 'fatalError', 'bargeIn', 'level']) {
      expect(swift).toContain(`emit("${event}"`);
    }
  });

  it('reports the availability shape the call path reads', () => {
    for (const key of ['recognition', 'synthesis', 'maxSpeechInputLength']) {
      expect(types).toContain(key);
    }
  });

  it('takes startSession options as a map on both platforms, matching the TS contract', () => {
    expect(tsModule).toContain('startSession(options: { title: string })');
    expect(kotlin).toMatch(/AsyncFunction\("startSession"\)\s*\{\s*options: Map<String, Any\?>, promise: Promise ->/);
    expect(kotlin).not.toMatch(/AsyncFunction\("startSession"\)\s*\{\s*title: String/);
    expect(swift).toMatch(/AsyncFunction\("startSession"\)\s*\{\s*\(options: \[String: Any\?\], promise: Promise\) in/);
    expect(swift).not.toMatch(/AsyncFunction\("startSession"\)\s*\{\s*\(title: String/);
  });

  it('answers availability from installed services, without constructing a TTS engine', () => {
    const availability = kotlin.slice(kotlin.indexOf('AsyncFunction("getAvailability")'), kotlin.indexOf('AsyncFunction("startSession")'));
    expect(availability).toContain('TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE');
    expect(availability).toContain('SpeechRecognizer.isRecognitionAvailable(');
    expect(availability).not.toContain('TextToSpeech(context)');
    expect(availability).not.toContain('postDelayed');
  });

  it('resolves startSession only when the service reports its foreground start, with a timeout', () => {
    expect(kotlin).toContain('HandsfreeCallService.pendingStartCallback =');
    expect(kotlin).toContain('START_TIMEOUT_MS');
    expect(kotlin).not.toMatch(/startForegroundService\(context, intent\)\s*\n\s*promise\.resolve\("started"\)/);
    expect(service).toMatch(/try\s*\{\s*startForegroundWithNotification\(title\)/);
    expect(service).toContain('deliverStart("unavailable")');
  });

  it('requires the microphone permission only; notifications are asked, not required', () => {
    const start = kotlin.slice(kotlin.indexOf('AsyncFunction("startSession")'), kotlin.indexOf('AsyncFunction("startListening")'));
    expect(start).toMatch(/val required = arrayOf\(Manifest\.permission\.RECORD_AUDIO\)/);
    expect(start).not.toMatch(/required[^\n]*POST_NOTIFICATIONS/);
  });

  it('retires the silent notification channel for a visible one', () => {
    expect(service).toContain('private const val CHANNEL_ID = "handsfree-call-v2"');
    expect(service).toContain('deleteNotificationChannel(LEGACY_CHANNEL_ID)');
    expect(service).toContain('NotificationManager.IMPORTANCE_DEFAULT');
  });

  it('does not end a call when another sound merely ducks it', () => {
    expect(service).toMatch(/AudioManager\.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> Unit/);
  });

  it('classifies recognizer errors through the tested helper and speaks progressively without dropping sentences', () => {
    expect(service).toContain('HandsfreeRecognizerErrors.classify(');
    expect(service).toContain('queuedSpeech.addAll(chunks)');
    expect(service).toMatch(/if \(speaking && nextChunkIndex < queuedSpeech\.size\) playChunk/);
  });

  it('opens the Gate media socket with echo-cancelled 16 kHz capture and a jittered 24 kHz output', () => {
    expect(gateMedia).toContain('MediaRecorder.AudioSource.VOICE_COMMUNICATION');
    expect(gateMedia).toContain('CAPTURE_SAMPLE_RATE = 16000');
    expect(gateMedia).toContain('PLAYBACK_SAMPLE_RATE = 24000');
    expect(gateMedia).toContain('JITTER_TARGET_MS = 60');
    expect(gateMedia).toContain('AcousticEchoCanceler.isAvailable()');
    expect(gateMedia).toContain('NoiseSuppressor.isAvailable()');
    expect(gateMedia).toContain('client.newWebSocket(');
    expect(gateMedia).toContain('GateFrameCodec.parse(');
    expect(gateMedia).toContain('buffer.push(currentGen');
  });

  it('forwards each Gate frame through the one gate event and stubs iOS as PENDING-MACOS', () => {
    expect(kotlin).toContain('sendEvent("gate"');
    expect(swift).toContain('PENDING-MACOS');
  });
});
