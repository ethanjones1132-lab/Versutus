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
    expect(tsModule).toContain('startSession(options: { title: string; startId?: string })');
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
    expect(kotlin).toContain('HandsfreeCallService.beginPendingStart(startId)');
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

  it('lets only the newest start attempt answer a permission dialog', () => {
    // A permission dialog outlives the JS deadline. The callback must check
    // that its id is still the newest before it posts startService, and
    // stopSession must cancel exactly its own id, so a late grant cannot open a
    // microphone behind a newer retry's back.
    const start = kotlin.slice(kotlin.indexOf('AsyncFunction("startSession")'), kotlin.indexOf('AsyncFunction("startListening")'));
    expect(start).toContain('HandsfreeCallService.claimStartAttempt(startId)');
    expect(start).toMatch(/if \(!HandsfreeCallService\.ownsStartAttempt\(startId\)\)/);
    expect(start).not.toMatch(/postDelayed\(\{ startService\(context, title, promise\) \}/);
    expect(kotlin).toMatch(/AsyncFunction\("stopSession"\)[\s\S]*?HandsfreeCallService\.(cancelStartAttempt|cancelAllStartAttempts)/);
    // iOS has the same dialog: a late authorization must be discarded too.
    expect(swift).toContain('attemptId == self.startAttemptId');
    expect(swift).toMatch(/self\.startAttemptId = attemptId/);
  });

  it('rejects a stale service intent before it opens the microphone', () => {
    // Ownership is checked at the top of `startSession`, before the owner
    // field, the call state, the foreground notification and audio focus. The
    // old check lived only in deliverStart, after the microphone was open and
    // the owner field had already been overwritten with the stale id.
    const session = service.slice(
      service.indexOf('fun startSession('),
      service.indexOf('private fun deliverStart('),
    );
    const guard = session.indexOf('ownsStartAttempt(attemptId)');
    const owner = session.indexOf('noteServiceStart(attemptId)');
    const stateStart = session.indexOf('state.start()');
    expect(guard).toBeGreaterThan(-1);
    expect(owner).toBeGreaterThan(guard);
    expect(stateStart).toBeGreaterThan(guard);
  });

  it('expiry invalidates its originating owner, so a stale start intent is rejected', () => {
    // The 4s timer must do more than clear the pending answer: a stale
    // ACTION_START the service has not processed yet would still pass
    // ownsStartAttempt and open the microphone. Expiry invalidates the owner
    // too. A newer retry's claim moved ownership on, so an old expiry reports
    // false and must not stop the newer service.
    const startService = kotlin.slice(kotlin.indexOf('private fun startService('), kotlin.indexOf('companion object'));
    expect(startService).toContain('HandsfreeCallService.expireStartAttempt(startId)');
    expect(startService).toMatch(/if \(HandsfreeCallService\.expireStartAttempt\(startId\)\)\s*\{/);
    expect(service).toContain('fun expireStartAttempt(id: String): Boolean = ownership.expire(id)');
    expect(service).not.toContain('fun releasePendingStart(');
    expect(service).toContain('fun beginPendingStart(id: String, callback: (String) -> Unit): Boolean');
    expect(service).toContain('fun cancelStartAttempt(id: String): Boolean');
    expect(service).toContain('fun ownsStartAttempt(id: String): Boolean');
    const ownership = readSource(
      'modules',
      'handsfree-voice',
      'android',
      'src',
      'main',
      'java',
      'com',
      'versutus',
      'handsfreevoice',
      'HandsfreeStartOwnership.kt',
    );
    // Expiry clears BOTH the owner and its pending answer, in one critical section.
    expect(ownership).toMatch(/fun expire\(id: String\): Boolean = synchronized\(lock\) \{[\s\S]*?owner = null/);
  });

  it('keys a teardown to its attempt and re-checks the service owner when it executes', () => {
    // The module queue is a background serial queue: a keyed cancel and the
    // service effects it triggers could interleave with a newer start's
    // ACTION_START. Ownership and media functions run on the main queue, the
    // same boundary the service's onStartCommand and its handler use. The
    // queued teardown is keyed and re-checked at execution, so an old cleanup
    // that lands after a newer service booted cannot end the newer call.
    expect(kotlin).toContain('import expo.modules.kotlin.functions.Queues');
    expect(kotlin).toMatch(/AsyncFunction\("startSession"\)[\s\S]*?\}\.runOnQueue\(Queues\.MAIN\)/);
    expect(kotlin).toMatch(/AsyncFunction\("stopSession"\)[\s\S]*?\}\.runOnQueue\(Queues\.MAIN\)/);
    expect(kotlin).toMatch(/AsyncFunction\("startGateMedia"\)[\s\S]*?\}\.runOnQueue\(Queues\.MAIN\)/);
    expect(service).toContain('fun endForAttempt(attemptId: String, reason: String)');
    expect(service).toMatch(
      /fun endForAttempt\(attemptId: String, reason: String\) \{[\s\S]*?if \(!HandsfreeCallService\.servesStartAttempt\(attemptId\)\) return@post/,
    );
    expect(service).toContain('fun servesStartAttempt(id: String): Boolean');
    expect(service).toContain('fun noteServiceStart(id: String?)');
    // A keyed stopSession uses the keyed teardown; the user's End stays unkeyed.
    expect(kotlin).toContain('endForAttempt(startId, "user")');
    expect(kotlin).toContain('HandsfreeCallService.current?.end("user")');
  });

  it('keys the Gate media start to its attempt so a delayed old open cannot replace a newer socket', () => {
    // The media link is the second half of a Gate start. It must carry the
    // attempt id, and Android must refuse a delayed start for an attempt a
    // newer retry has superseded.
    expect(types).toMatch(/startId\?: string;/);
    expect(kotlin).toMatch(
      /AsyncFunction\("startGateMedia"\)[\s\S]*?val startId = \(options\["startId"\] as\? String\)/,
    );
    expect(kotlin).toMatch(/if \(startId != null && !HandsfreeCallService\.ownsStartAttempt\(startId\)\)/);
    expect(tsModule).toContain('startGateMedia(options: HandsfreeGateMediaOptions)');
  });

  it('keys cancellation to its own attempt through a single-lock ownership record', () => {
    // The owner and the pending answer move together under one lock: the old
    // design used a `@Volatile` counter bumped with `+=` and a check-then-clear
    // on the callback, which let a stale answer clear — or a stale cancel end —
    // a newer attempt.
    expect(service).toContain('HandsfreeStartOwnership()');
    expect(kotlin).toMatch(/HandsfreeCallService\.cancelStartAttempt\(startId\)/);
    // A stopSession with no id is the user's End: it supersedes everything.
    expect(kotlin).toContain('HandsfreeCallService.cancelAllStartAttempts()');
    const ownership = readSource(
      'modules',
      'handsfree-voice',
      'android',
      'src',
      'main',
      'java',
      'com',
      'versutus',
      'handsfreevoice',
      'HandsfreeStartOwnership.kt',
    );
    expect(ownership).toContain('synchronized(lock)');
    // The rule is about the code, not the KDoc that names the design it
    // replaced: strip comments so the prose mention cannot stand in for a real
    // `@Volatile` field.
    const ownershipCode = ownership
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(ownershipCode).not.toContain('@Volatile');
  });

  it('retires the silent notification channel for a visible one', () => {
    expect(service).toContain('private const val CHANNEL_ID = "handsfree-call-v2"');
    expect(service).toContain('deleteNotificationChannel(LEGACY_CHANNEL_ID)');
    expect(service).toContain('NotificationManager.IMPORTANCE_DEFAULT');
  });

  it('does not end a call when another sound merely ducks it', () => {
    // The rule moved out of the service's focus listener into the JVM-tested
    // HandsfreeFocusPolicy (2026-09-16), so the listener is pinned to route
    // every focus change through it, and the policy is pinned to end the call
    // only on a real loss — a duck falls to `else -> false`. The cases
    // themselves are proved in HandsfreeFocusPolicyTest.kt.
    expect(service).toContain('HandsfreeFocusPolicy.endsCall(change, msSinceListenStart)');
    const policy = readSource(
      'modules',
      'handsfree-voice',
      'android',
      'src',
      'main',
      'java',
      'com',
      'versutus',
      'handsfreevoice',
      'HandsfreeFocusPolicy.kt',
    );
    expect(policy).toMatch(/AudioManager\.AUDIOFOCUS_LOSS -> true/);
    expect(policy).toMatch(/else -> false/);
    expect(policy).not.toMatch(/AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK/);
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
