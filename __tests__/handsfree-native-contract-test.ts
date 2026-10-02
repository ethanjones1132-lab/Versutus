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

function between(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) return '';
  const rest = src.slice(start + startMarker.length);
  const end = rest.indexOf(endMarker);
  return end === -1 ? rest : rest.slice(0, end);
}

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

  it('echo-cancels the barge-in tap the same way the Gate media path does', () => {
    // The phone engine armed barge-in on a VOICE_COMMUNICATION AudioRecord with
    // no AcousticEchoCanceler and no NoiseSuppressor, then seeded the floor from
    // a silent pre-speech sample. TTS on the loudspeaker crossed 0.03 RMS within
    // ~300 ms and truncated every reply. The Gate media path already attaches
    // both effects; this tap has to as well.
    const barge = between(service, 'private fun startBargeIn()', 'private fun handleBargeIn()');
    expect(barge).toContain('AcousticEchoCanceler');
    expect(barge).toContain('NoiseSuppressor');
    // Reseeding from 0 every reply made the first silent sample the floor.
    expect(barge).not.toMatch(/noiseFloor\s*=\s*0\.0/);
  });

  it('startListening reports ready only after onReadyForSpeech, never on the post', () => {
    // The function used to post startListeningInternal and return true. The
    // provider's retry loop treated that as "the recognizer can hear", so the
    // banner said Listening while a cold Samsung bind still had nothing
    // consuming the microphone.
    const start = between(service, 'fun startListening(): Boolean {', 'private fun ensureRecognizer()');
    expect(start).not.toMatch(/mainHandler\.post \{ startListeningInternal\(\) \}\s*\n\s*return true/);
    expect(start).toContain('readyForSpeech');
    const ready = between(service, 'override fun onReadyForSpeech', 'override fun onBeginningOfSpeech');
    expect(ready.replace(/\s+/g, ' ').trim()).not.toBe('(params: android.os.Bundle?) {}');
    expect(ready).toContain('readyForSpeech');
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

// The iOS half of the seam is Swift, which this suite cannot execute. These
// cases pin the invariants by reading the source, the same way the rest of this
// file pins the wiring: each one fails on the defect it names, so a regression
// in the Swift is a red test here rather than a device-only surprise.
describe('the iOS module is a clean slate per call', () => {
  it('clears the mute flag on every end, including the inactive early return', () => {
    // `isMuted` has exactly one writer, `setMuted`. Android is immune because
    // `HandsfreeCallState.start()` resets `muted`; iOS resets it here, before
    // the `sessionActive` guard, so a call that ended while muted cannot leave
    // the next call unable to listen.
    const end = between(swift, 'private func endLocked(reason: String) {', '// MARK: - Events');
    const clear = end.indexOf('self.isMuted = false');
    const guard = end.indexOf('guard self.sessionActive else { return }');
    expect(clear).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(guard);
    // The Android twin is immune by construction, and stays that way.
    const state = readSource(
      'modules',
      'handsfree-voice',
      'android',
      'src',
      'main',
      'java',
      'com',
      'versutus',
      'handsfreevoice',
      'HandsfreeCallState.kt',
    );
    expect(state).toMatch(/fun start\([\s\S]*?muted = false/);
  });

  it('resets the per-call flags on a successful start, not only on end', () => {
    const started = between(swift, 'self.sessionActive = true', 'DispatchQueue.main.async { promise.resolve("started") }');
    expect(started).toContain('self.isMuted = false');
    expect(started).toContain('self.isListening = false');
    expect(started).toContain('self.isFinishingTurn = false');
    // The queue is flushed, not adopted: the new call has its own replies.
    expect(started).toContain('self.stopSpeakingLocked()');
    // A start whose engine refuses is still a fresh call.
    const refused = between(swift, 'if !self.startEngineIfNeeded() {', 'DispatchQueue.main.async { promise.resolve("started") }');
    expect(refused).toContain('self.sessionActive = false');
  });

  it('keeps the start attempt id superseded on end, unchanged by the reset', () => {
    const end = between(swift, 'private func endLocked(reason: String) {', '// MARK: - Events');
    expect(end).toContain('self.startAttemptId = nil');
    expect(end.indexOf('self.startAttemptId = nil')).toBeLessThan(end.indexOf('self.isMuted = false'));
  });
});

describe('iOS progressive speech queues instead of truncating', () => {
  const speak = between(swift, 'private func speakLocked(', 'private func speakNextChunk()');

  it('appends to a running queue rather than replacing it and cancelling', () => {
    // Android's `speakInternal` does exactly this. iOS overwrote `pendingChunks`
    // and stopped the synthesizer on every streamed sentence, so each reply was
    // cut off mid-word.
    expect(service).toContain('queuedSpeech.addAll(chunks)');
    expect(speak).toContain('pendingChunks.append(contentsOf: chunks)');
    expect(speak).not.toContain('stopSpeaking(at:');
    // The append returns before the new-generation setup.
    const append = speak.indexOf('pendingChunks.append(contentsOf: chunks)');
    const generation = speak.indexOf('speechGeneration += 1');
    expect(append).toBeGreaterThan(-1);
    expect(generation).toBeGreaterThan(append);
    // The queued sentence keeps the voice it was asked for: the running
    // utterance already has its own copy, so the fields can be set before the
    // append. Android does the same, assigning `pendingVoiceIdentifier` and
    // friends ahead of its own `if (speaking)` check.
    expect(speak.indexOf('self.voiceIdentifier = voiceIdentifier')).toBeLessThan(append);
    expect(speak).toContain('self.speechRate = rate');
    expect(speak).toContain('self.speechPitch = pitch');
    expect(service.indexOf('pendingVoiceIdentifier = voiceIdentifier')).toBeLessThan(
      service.indexOf('queuedSpeech.addAll(chunks)'),
    );
  });

  it('still starts a fresh utterance when nothing is speaking', () => {
    expect(speak).toMatch(/guard sessionActive, !destroyed else \{ return \}[\s\S]*?if isSpeaking \{[\s\S]*?return\n\s*\}/);
    expect(speak).toContain('speechGeneration += 1');
    expect(speak).toContain('pendingChunks = chunks');
    expect(speak).toContain('isSpeaking = true');
    expect(speak).toContain('speakNextChunk()');
    // Recognition is off before speech, on the path that actually speaks.
    expect(speak.indexOf('if isListening { stopListeningLocked() }')).toBeGreaterThan(
      speak.indexOf('pendingChunks.append(contentsOf: chunks)'),
    );
  });

  it('stops listening on every speak, so a queued sentence never re-opens the mic', () => {
    // The first speech already closes recognition; a progressive append cannot
    // re-open it, since the append branch returns before any state is touched.
    expect(speak).toContain('if isListening { stopListeningLocked() }');
    expect(speak.indexOf('pendingChunks.append(contentsOf: chunks)')).toBeLessThan(
      speak.indexOf('if isListening { stopListeningLocked() }'),
    );
  });

  it('flushes the queue on stopSpeaking, which is how JS starts a fresh reply', () => {
    const stop = between(swift, 'private func stopSpeakingLocked() {', 'private func handleBargeIn()');
    expect(stop).toContain('pendingChunks.removeAll()');
    expect(stop).toContain('speakingUtterance = nil');
    expect(stop).toMatch(/if synthesizer\.isSpeaking \{\s*synthesizer\.stopSpeaking\(at: \.immediate\)/);
    // Barge-in flushes through the same path.
    const barge = between(swift, 'private func handleBargeIn() {', '// MARK: - Earcon');
    expect(barge).toContain('stopSpeakingLocked()');
  });

  it('does not let a cancelled utterance advance the queue', () => {
    // `stopSpeaking(at: .immediate)` cancels the in-flight utterance. If that
    // utterance's completion still arrives, advancing would shift the next
    // reply's first sentence off the queue before it was spoken.
    expect(swift).toContain('speakingUtterance: AVSpeechUtterance?');
    expect(swift).toContain('private func utteranceFinished(_ utterance: AVSpeechUtterance)');
    const advance = between(swift, 'private func utteranceFinished(', 'private func stopSpeakingLocked()');
    expect(advance).toContain('utterance === self.speakingUtterance');
    expect(advance).toContain('self.speakNextChunk()');
    // The delegate hands over the utterance it finished, not just a bare event.
    expect(swift).toMatch(/HandsfreeSpeechDelegate \{ \[weak self\] utterance in[\s\S]*?utteranceFinished\(utterance\)/);
    expect(swift).toContain('private let onFinish: (AVSpeechUtterance) -> Void');
  });
});

describe('a failing iOS recogniser backs off instead of spinning', () => {
  const handle = between(swift, 'private func handleRecognition(', 'private func finishTurn(');

  it('counts the streak and ends the call at the bound', () => {
    expect(swift).toContain('private var consecutiveRecognitionErrors = 0');
    expect(handle).toContain('consecutiveRecognitionErrors += 1');
    // The bound is reached by escalation, not by any framework timeout.
    expect(handle).toMatch(/if consecutiveRecognitionErrors >= HandsfreeVoiceModule\.maxRecognitionRestarts \{[\s\S]*?emit\("fatalError"/);
    expect(swift).toContain('private static let maxRecognitionRestarts = 5');
    // The terminal shape is the one the not-listening branch already emits.
    const terminal = between(swift, 'if consecutiveRecognitionErrors >=', '} else {\n        emit("fatalError"');
    expect(terminal).toContain('"reason": "recognition-failed"');
    expect(terminal).toContain('error.localizedDescription');
    expect(terminal).toContain('end(reason: "recognition-failed")');
  });

  it('resets the streak on any recognised speech and on a normal final', () => {
    expect(handle).toMatch(/if result\.isFinal \{[\s\S]*?consecutiveRecognitionErrors = 0[\s\S]*?finishTurn\(text: text\)/);
    expect(handle).toMatch(/if !text\.isEmpty \{[\s\S]*?consecutiveRecognitionErrors = 0/);
    // A new call starts with no history either.
    expect(swift).toMatch(/self\.sessionActive = true[\s\S]*?self\.consecutiveRecognitionErrors = 0/);
  });

  it('delays the restart with a capped exponential backoff, guarded against staleness', () => {
    expect(swift).toContain('private static let recognitionRestartBase: TimeInterval = 0.25');
    expect(swift).toContain('private static let recognitionRestartMax: TimeInterval = 4');
    expect(swift).toContain('private func recognitionRestartDelay() -> TimeInterval');
    const delay = between(swift, 'private func recognitionRestartDelay()', 'private func scheduleRecognitionRestart(');
    // Doubling per streak, capped. Four restarts reach 2s; the 5th error ends
    // the call, so the 4s ceiling is a bound rather than a scheduled value.
    expect(delay).toContain('Double(1 << min(step, 4))');
    expect(delay).toMatch(/min\([\s\S]*?recognitionRestartMax/);
    const schedule = between(swift, 'private func scheduleRecognitionRestart(', 'private func stopListeningLocked()');
    expect(schedule).toContain('audioQueue.asyncAfter(deadline: .now() + delay)');
    expect(schedule).toMatch(/guard token == self\.turnToken,[\s\S]*?self\.sessionActive,[\s\S]*?!self\.isSpeaking,[\s\S]*?!self\.destroyed[\s\S]*?else \{ return \}/);
    expect(schedule).toContain('self.beginRecognition()');
  });

  it('emits one noSpeech per streak, not one per failed retry', () => {
    expect(handle).toContain('emitSilence: consecutiveRecognitionErrors == 1');
    const finish = between(swift, 'private func finishTurn(', 'private func recognitionRestartDelay()');
    expect(finish).toContain('emitSilence: Bool = true');
    expect(finish).toMatch(/if text\.isEmpty \{\s*if emitSilence \{\s*emit\("noSpeech", \["reason": "silence"\]\)/);
  });

  it('retires the turn token when the turn closes, so a cancelled task cannot end the call', () => {
    // With the restart delayed there is now a window in which `isListening` is
    // false and the cancelled task's own terminal error is still in flight. That
    // callback takes the branch which ends the call as broken, so the token has
    // to move here, not only in `beginRecognition`.
    const finish = between(swift, 'private func finishTurn(', 'private func stopListeningLocked() {');
    expect(finish).toMatch(/recognitionTask = nil[\s\S]*?turnToken \+= 1[\s\S]*?endpointing\.reset\(\)/);
    // `stopListeningLocked` still moves it, so mute and End invalidate a pending
    // restart exactly as they invalidate a live turn.
    const stop = between(swift, 'private func stopListeningLocked() {', '// MARK: - Speech');
    expect(stop).toContain('turnToken += 1');
  });

  it('restarts immediately for ordinary silence, and only the error path waits', () => {
    const finish = between(swift, 'private func finishTurn(', 'private func recognitionRestartDelay()');
    expect(finish).toMatch(/guard let delay = restartAfter else \{\s*beginRecognition\(\)/);
    // The final branch of a recognised turn never passes a delay.
    expect(swift).not.toMatch(/finishTurn\(text: text,[^)]*restartAfter/);
    expect(handle).toContain('restartAfter: recognitionRestartDelay()');
  });
});

describe('iOS state is read on the queue that writes it', () => {
  it('declares no lock it does not use', () => {
    expect(swift).not.toContain('stateLock');
    expect(swift).not.toContain('NSLock');
  });

  it('reads the guards through audioQueue.sync, not on the calling thread', () => {
    const listen = between(swift, 'AsyncFunction("startListening")', 'AsyncFunction("stopListening")');
    expect(listen).toMatch(/let allowed = self\.audioQueue\.sync \{ self\.sessionActive && !self\.isMuted \}/);
    const speak = between(swift, 'AsyncFunction("speak")', 'AsyncFunction("stopSpeaking")');
    expect(speak).toMatch(/let active = self\.audioQueue\.sync \{ self\.sessionActive \}/);
    // The decision stays on the queue: the work is still dispatched, not run
    // inline, so the queue's ordering is the whole contract.
    expect(listen).toContain('self.audioQueue.async { self.beginRecognition() }');
    expect(speak).toContain('self.audioQueue.async {');
  });

  it('keeps the streaming reads on the queue, as beginRecognition already did', () => {
    // `end`, the notification observers and the input tap all mutate or read
    // state from a dispatched block, never inline.
    expect(swift).toMatch(/private func end\(reason: String\) \{\s*audioQueue\.async \{ self\.endLocked\(reason: reason\) \}/);
    expect(swift).toMatch(/AsyncFunction\("setMuted"\)[\s\S]*?self\.audioQueue\.async \{[\s\S]*?self\.isMuted = muted/);
  });
});
