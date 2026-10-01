import ExpoModulesCore
import AVFoundation
import Speech

/// The iOS hands-free call module.
///
/// It owns the call's `AVAudioEngine`, the `SFSpeechRecognizer` tasks and the
/// `AVSpeechSynthesizer` queue for exactly the lifetime of a user-started
/// session. One input tap is installed for the whole session and branches: it
/// feeds the active recognition request, or (while speaking) computes the
/// amplitude used for the barge-in detector and the ambient level event. When
/// neither is active the samples are discarded and nothing is persisted.
public class HandsfreeVoiceModule: Module {
  public static weak var current: HandsfreeVoiceModule?

  /**
   * The one owner of every field below. State is read and written only from a
   * block dispatched to `audioQueue`, and an entry point that needs a decision
   * out of that state reads it with `audioQueue.sync` rather than on the
   * calling thread. The queue is the lock; a second one would be a lie.
   */
  private let audioQueue = DispatchQueue(label: "com.versutus.handsfreevoice.audio")

  /// Consecutive failed recognition turns before the call is ended as broken.
  private static let maxRecognitionRestarts = 5
  private static let recognitionRestartBase: TimeInterval = 0.25
  private static let recognitionRestartMax: TimeInterval = 4

  private var audioEngine: AVAudioEngine?
  private var speechRecognizer: SFSpeechRecognizer?
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var synthesizer = AVSpeechSynthesizer()
  private var synthDelegate: HandsfreeSpeechDelegate?
  private var earconPlayer: AVAudioPlayer?
  private let endpointing = HandsfreeEndpointing()

  private var sessionActive = false
  private var destroyed = false
  private var isListening = false
  private var isFinishingTurn = false
  private var isSpeaking = false
  private var isMuted = false
  private var turnToken = 0
  private var speechGeneration = 0
  private var pendingChunks: [String] = []
  /**
   * The utterance the synthesizer is speaking now. A cancelled utterance can
   * still report completion on some iOS versions, and treating that as a finish
   * would shift a sentence off the queue before it was ever spoken.
   */
  private var speakingUtterance: AVSpeechUtterance?
  private var voiceIdentifier: String?
  private var speechRate: Float?
  private var speechPitch: Float?
  private var lastPartial = ""
  private var onsetStart: TimeInterval = 0
  private var lastLevelEmit: TimeInterval = 0
  /**
   * How many recognition tasks have died mid-turn in a row. A recogniser that
   * fails the instant it is created would otherwise spin; the streak bounds the
   * retries and then ends the call. Zeroed by any turn that produced speech.
   */
  private var consecutiveRecognitionErrors = 0
  /**
   * The id of the newest start the module has claimed. A `stopSession` for an
   * older id (or a newer start) moves it on, so an answer the OS permission
   * dialog delivers late cannot activate audio behind a newer retry's back.
   * Touched on `audioQueue` only.
   */
  private var startAttemptId: String?

  private var interruptionObserver: NSObjectProtocol?
  private var routeObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("HandsfreeVoice")

    Events(
      "partial",
      "final",
      "noSpeech",
      "speechFinished",
      "interruption",
      "endRequested",
      "fatalError",
      "bargeIn",
      "level",
      "gate"
    )

    OnCreate {
      HandsfreeVoiceModule.current = self
      self.synthDelegate = HandsfreeSpeechDelegate { [weak self] utterance in
        self?.utteranceFinished(utterance)
      }
      self.synthesizer.delegate = self.synthDelegate
      self.observeAudioSession()
    }

    OnDestroy {
      HandsfreeVoiceModule.current = nil
      self.teardown(reason: "app-killed")
      self.removeObservers()
    }

    AsyncFunction("getAvailability") { (promise: Promise) in
      let recognizer = SFSpeechRecognizer(locale: Locale.current)
      let recognition = recognizer?.isAvailable == true
      promise.resolve([
        "recognition": recognition,
        "synthesis": true,
        // iOS has no finite platform speech-input bound; `speechChunks`
        // treats any positive bound as "a reply this can hold in one chunk".
        "maxSpeechInputLength": Double.greatestFiniteMagnitude
      ])
    }

    AsyncFunction("startSession") { (options: [String: Any?], promise: Promise) in
      _ = options["title"] as? String
      // The key this attempt's cancellation will name. JS supplies it so an
      // abandoned start cancels exactly itself; the fallback covers a caller
      // that never cancels.
      let requestedId = (options["startId"] as? String)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
      self.audioQueue.async {
        // Claim this start before the permission prompt. A `stopSession` for
        // this id, or a newer start, takes the id on, so a grant that lands
        // after JS gave up is discarded instead of activating audio with no
        // call behind it.
        let attemptId = (requestedId?.isEmpty == false) ? requestedId! : UUID().uuidString
        self.startAttemptId = attemptId
        self.requestAuthorization { granted in
          self.audioQueue.async {
            guard attemptId == self.startAttemptId else {
              DispatchQueue.main.async { promise.resolve("unavailable") }
              return
            }
            guard granted else {
              DispatchQueue.main.async { promise.resolve("permission-denied") }
              return
            }
            do {
              try self.activateAudioSession()
            } catch {
              DispatchQueue.main.async { promise.resolve("unavailable") }
              return
            }
            self.sessionActive = true
            self.destroyed = false
            // A new call starts from a clean slate. `isMuted` in particular is
            // written only by `setMuted`, so without this a call that ended
            // while muted would leave every later call unable to listen and
            // killing it ~1.2s in with "recognition-failed".
            self.isMuted = false
            self.isListening = false
            self.isFinishingTurn = false
            self.consecutiveRecognitionErrors = 0
            // Any speech queue a previous call left behind is flushed here, not
            // adopted: the new call has its own replies to speak.
            self.stopSpeakingLocked()
            if !self.startEngineIfNeeded() {
              self.sessionActive = false
              DispatchQueue.main.async { promise.resolve("unavailable") }
              return
            }
            DispatchQueue.main.async { promise.resolve("started") }
          }
        }
      }
    }

    AsyncFunction("startListening") { () -> Bool in
      // Read on the queue that writes the state. An AsyncFunction body runs on
      // Expo's own queue, never on `audioQueue`, so a `sync` read here cannot
      // deadlock: nothing dispatched to `audioQueue` waits on this thread.
      let allowed = self.audioQueue.sync { self.sessionActive && !self.isMuted }
      guard allowed else { return false }
      self.audioQueue.async { self.beginRecognition() }
      return true
    }

    AsyncFunction("stopListening") {
      self.audioQueue.async { self.stopListeningLocked() }
    }

    AsyncFunction("speak") { (options: [String: Any?]) -> Bool in
      let chunks = (options["chunks"] as? [String]) ?? []
      let voice = options["voiceIdentifier"] as? String
      let rate = (options["rate"] as? NSNumber)?.floatValue
      let pitch = (options["pitch"] as? NSNumber)?.floatValue
      let usable = chunks.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
      guard !usable.isEmpty else { return false }
      // `sessionActive` is read on `audioQueue`, the queue that writes it.
      let active = self.audioQueue.sync { self.sessionActive }
      guard active else { return false }
      self.audioQueue.async {
        self.speakLocked(chunks: usable, voiceIdentifier: voice, rate: rate, pitch: pitch)
      }
      return true
    }

    AsyncFunction("stopSpeaking") {
      self.audioQueue.async { self.stopSpeakingLocked() }
    }

    AsyncFunction("setMuted") { (muted: Bool) in
      self.audioQueue.async {
        guard self.sessionActive else { return }
        self.isMuted = muted
        if muted {
          self.stopListeningLocked()
        }
        // Unmuting does not itself open a turn; the JS reducer asks for
        // recognition when it is in a listening phase.
      }
    }

    AsyncFunction("playSendEarcon") {
      self.audioQueue.async { self.playEarconLocked() }
    }

    AsyncFunction("stopSession") { (options: [String: Any?]?) in
      let requestedId = (options?["startId"] as? String)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
      self.audioQueue.async {
        if let id = requestedId, !id.isEmpty {
          // Cancel exactly this attempt. A stale id — a newer retry owns the
          // start — cancels nothing and must not end the newer call.
          guard id == self.startAttemptId else { return }
        }
        // No id is the user's End: it owns the whole native side.
        self.endLocked(reason: "user")
      }
    }

    // PENDING-MACOS: the Gate media terminal (OkHttp/URLSession WebSocket,
    // AudioRecord-equivalent capture, jittered playback) has no iOS
    // implementation yet. The signatures exist so the cross-platform contract
    // test does not drift; calling them resolves false rather than pretending.
    AsyncFunction("startGateMedia") { (_: [String: Any?], promise: Promise) in
      promise.resolve(false)
    }

    AsyncFunction("sendGateControl") { (_: String) -> Bool in
      false
    }

    AsyncFunction("stopGateMedia") {}

    // PENDING-MACOS: the widget and its signed auto-start are Android-only, so
    // an iOS launch link is never signed.
    AsyncFunction("verifyLaunch") { (_: String) -> Bool in
      false
    }
  }

  // MARK: - Session

  private func activateAudioSession() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(
      .playAndRecord,
      mode: .voiceChat,
      options: [.defaultToSpeaker, .allowBluetooth]
    )
    try session.setActive(true, options: [])
  }

  private func requestAuthorization(_ completion: @escaping (Bool) -> Void) {
    let speechStatus = SFSpeechRecognizer.authorizationStatus()
    let recordStatus = AVAudioSession.sharedInstance().recordPermission
    let group = DispatchGroup()
    var speechGranted = speechStatus == .authorized
    var recordGranted = recordStatus == .granted

    if speechStatus == .notDetermined {
      group.enter()
      SFSpeechRecognizer.requestAuthorization { status in
        speechGranted = status == .authorized
        group.leave()
      }
    }
    if recordStatus == .undetermined {
      group.enter()
      AVAudioSession.sharedInstance().requestRecordPermission { granted in
        recordGranted = granted
        group.leave()
      }
    }
    group.notify(queue: .main) {
      completion(speechGranted && recordGranted)
    }
  }

  private func startEngineIfNeeded() -> Bool {
    if let engine = audioEngine {
      if !engine.isRunning {
        do {
          try engine.start()
        } catch {
          return false
        }
      }
      return true
    }
    speechRecognizer = SFSpeechRecognizer(locale: Locale.current)
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else { return false }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      // The buffer is retained by this closure; processing is serialized with
      // every control change on `audioQueue`.
      self?.audioQueue.async { self?.process(buffer: buffer) }
    }
    engine.prepare()
    do {
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      return false
    }
    audioEngine = engine
    return true
  }

  // MARK: - The one input tap

  private func process(buffer: AVAudioPCMBuffer) {
    guard sessionActive, !destroyed else { return }
    let now = ProcessInfo.processInfo.systemUptime
    let level = rms(of: buffer)
    endpointing.updateNoiseFloor(level)

    if isSpeaking {
      if endpointing.isVoice(level) {
        if onsetStart == 0 { onsetStart = now }
        if now - onsetStart >= 0.25 {
          onsetStart = 0
          handleBargeIn()
          return
        }
      } else {
        onsetStart = 0
      }
      emitLevel(level, now: now)
      return
    }

    guard let request = recognitionRequest else {
      // Waiting: the background mode stays legitimate but ambient audio is
      // discarded, never recognized and never persisted.
      return
    }

    if endpointing.isVoice(level) {
      endpointing.onVoice(at: now)
    }
    request.append(buffer)
    emitLevel(level, now: now)

    if isFinishingTurn { return }
    if endpointing.isPastCeiling(at: now) || endpointing.shouldFinishForSilence(at: now) {
      isFinishingTurn = true
      request.endAudio()
    } else if endpointing.noSpeechTimedOut(at: now) {
      isFinishingTurn = true
      request.endAudio()
    }
  }

  private func rms(of buffer: AVAudioPCMBuffer) -> Float {
    guard let channel = buffer.floatChannelData?[0] else { return 0 }
    let count = Int(buffer.frameLength)
    if count == 0 { return 0 }
    var sum: Float = 0
    for i in 0..<count {
      let sample = channel[i]
      sum += sample * sample
    }
    return (sum / Float(count)).squareRoot()
  }

  // MARK: - Recognition

  private func beginRecognition() {
    guard sessionActive, !isMuted, !isListening, !isSpeaking, !destroyed else { return }
    guard let recognizer = speechRecognizer, recognizer.isAvailable else {
      emit("fatalError", ["reason": "recognition-failed", "message": "recognizer-unavailable"])
      end(reason: "recognition-failed")
      return
    }
    isListening = true
    isFinishingTurn = false
    turnToken += 1
    let token = turnToken
    lastPartial = ""
    endpointing.begin(at: ProcessInfo.processInfo.systemUptime)

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    recognitionRequest = request
    recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
      self?.audioQueue.async {
        self?.handleRecognition(token: token, result: result, error: error)
      }
    }
  }

  private func handleRecognition(
    token: Int,
    result: SFSpeechRecognitionResult?,
    error: Error?
  ) {
    guard token == turnToken else { return }
    if let result = result {
      let text = result.bestTranscription.formattedString
        .trimmingCharacters(in: .whitespacesAndNewlines)
      if result.isFinal {
        // A normal completion, silent or not, is a live recogniser.
        consecutiveRecognitionErrors = 0
        finishTurn(text: text)
        return
      }
      if !text.isEmpty {
        // Any recognised speech proves the recogniser is alive, so the restart
        // streak is over.
        consecutiveRecognitionErrors = 0
      }
      if !text.isEmpty && text != lastPartial {
        lastPartial = text
        emit("partial", ["text": text])
      }
      return
    }
    if let error = error {
      if isListening {
        // A recognition that dies mid-turn is not fatal to the first failure:
        // the turn closes as no speech and the next one starts fresh. But a
        // recogniser that fails the instant it is created - revoked mic access,
        // no network for server-side recognition, a wedged SFSpeechRecognizer -
        // used to spin here: a request and task created and torn down as fast
        // as the framework answered, one noSpeech per pass into JS, and
        // `endpointing.begin` resetting the no-speech clock each time so it
        // never tripped. The streak bounds it, and the restart waits.
        consecutiveRecognitionErrors += 1
        if consecutiveRecognitionErrors >= HandsfreeVoiceModule.maxRecognitionRestarts {
          stopListeningLocked()
          emit("fatalError", [
            "reason": "recognition-failed",
            "message": error.localizedDescription
          ])
          end(reason: "recognition-failed")
          return
        }
        // One noSpeech per streak is enough for the JS grace window; the rest of
        // the streak is silent so the banner does not flicker per retry.
        finishTurn(
          text: "",
          emitSilence: consecutiveRecognitionErrors == 1,
          restartAfter: recognitionRestartDelay()
        )
      } else {
        emit("fatalError", [
          "reason": "recognition-failed",
          "message": error.localizedDescription
        ])
        end(reason: "recognition-failed")
      }
    }
  }

  private func finishTurn(
    text: String,
    emitSilence: Bool = true,
    restartAfter: TimeInterval? = nil
  ) {
    isListening = false
    isFinishingTurn = false
    recognitionTask?.cancel()
    recognitionRequest = nil
    recognitionTask = nil
    // Retire this turn's token here, not only in `beginRecognition`: a cancelled
    // task still reports its own terminal error, and when the restart is delayed
    // that callback arrives with `isListening` false - the branch that ends the
    // call as broken. Moving the token here discards it whichever way the restart
    // is scheduled; `beginRecognition` bumps it again on the immediate path.
    turnToken += 1
    endpointing.reset()
    if text.isEmpty {
      if emitSilence {
        emit("noSpeech", ["reason": "silence"])
      }
    } else {
      emit("final", ["text": text])
    }
    // Restart immediately: the JS grace window can only cancel a pending send
    // in favour of a resumed utterance if the recognizer is already listening
    // again, and restart latency otherwise clips the first syllables. Only a
    // failed recognition waits, and then only for its backoff.
    if isSpeaking { return }
    guard let delay = restartAfter else {
      beginRecognition()
      return
    }
    scheduleRecognitionRestart(after: delay)
  }

  /**
   * 250ms, then doubling, capped at 4s: long enough that a wedged recogniser
   * stops burning the CPU, short enough that a transient failure is invisible.
   */
  private func recognitionRestartDelay() -> TimeInterval {
    let step = max(consecutiveRecognitionErrors - 1, 0)
    return min(
      HandsfreeVoiceModule.recognitionRestartBase * Double(1 << min(step, 4)),
      HandsfreeVoiceModule.recognitionRestartMax
    )
  }

  /**
   * Reopen recognition after a failed turn, once the backoff has elapsed. The
   * guard is the turn token plus the live-call flags, so a restart that outlives
   * its call - or the mute, barge-in or End that ended the turn - does nothing.
   */
  private func scheduleRecognitionRestart(after delay: TimeInterval) {
    let token = turnToken
    audioQueue.asyncAfter(deadline: .now() + delay) { [weak self] in
      guard let self = self else { return }
      guard token == self.turnToken,
        self.sessionActive,
        !self.isSpeaking,
        !self.destroyed
      else { return }
      self.beginRecognition()
    }
  }

  private func stopListeningLocked() {
    turnToken += 1
    isListening = false
    isFinishingTurn = false
    recognitionTask?.cancel()
    recognitionRequest = nil
    recognitionTask = nil
    endpointing.reset()
  }

  // MARK: - Speech

  private func speakLocked(
    chunks: [String],
    voiceIdentifier: String?,
    rate: Float?,
    pitch: Float?
  ) {
    guard sessionActive, !destroyed else { return }
    if isSpeaking {
      // Progressive speech: JS calls `speak` once per newly completed sentence
      // while a reply streams, so a call that lands mid-utterance joins the
      // queue the way Android's `speakInternal` does. Replacing the queue here
      // and stopping the synthesizer truncated the reply mid-word and, if the
      // cancelled utterance still reported completion, skipped a sentence.
      // The running utterance keeps its own voice/rate/pitch; these values apply
      // to the chunks that follow it, as Android's `speakInternal` does. A fresh
      // reply is introduced by JS calling `stopSpeaking` first, which still
      // flushes everything.
      self.voiceIdentifier = voiceIdentifier
      self.speechRate = rate
      self.speechPitch = pitch
      pendingChunks.append(contentsOf: chunks)
      return
    }
    // Recognition is off before speech so the reply is not heard back.
    if isListening { stopListeningLocked() }
    self.voiceIdentifier = voiceIdentifier
    self.speechRate = rate
    self.speechPitch = pitch
    speechGeneration += 1
    pendingChunks = chunks
    isSpeaking = true
    speakNextChunk()
  }

  private func speakNextChunk() {
    guard isSpeaking, speechGeneration > 0 else { return }
    if pendingChunks.isEmpty {
      isSpeaking = false
      speakingUtterance = nil
      onsetStart = 0
      emit("speechFinished", ["reason": "done"])
      return
    }
    let chunk = pendingChunks.removeFirst()
    let utterance = AVSpeechUtterance(string: chunk)
    speakingUtterance = utterance
    if let identifier = voiceIdentifier, let voice = AVSpeechSynthesisVoice(identifier: identifier) {
      utterance.voice = voice
    }
    if let rate = speechRate {
      utterance.rate = min(max(rate, AVSpeechUtteranceMinimumSpeechRate), AVSpeechUtteranceMaximumSpeechRate)
    }
    if let pitch = speechPitch {
      utterance.pitchMultiplier = min(max(pitch, 0.5), 2.0)
    }
    synthesizer.speak(utterance)
  }

  /**
   * The utterance that just finished may advance the queue, but only if it is
   * the one currently speaking. The small correctness guard: `stopSpeaking` and
   * barge-in both cancel, and a cancelled utterance's completion callback must
   * not shift a fresh reply's first sentence off the queue.
   */
  private func utteranceFinished(_ utterance: AVSpeechUtterance) {
    audioQueue.async { [weak self] in
      guard let self = self else { return }
      guard self.isSpeaking,
        self.speechGeneration > 0,
        utterance === self.speakingUtterance
      else { return }
      self.speakingUtterance = nil
      self.speakNextChunk()
    }
  }

  private func stopSpeakingLocked() {
    speechGeneration += 1
    isSpeaking = false
    onsetStart = 0
    pendingChunks.removeAll()
    speakingUtterance = nil
    if synthesizer.isSpeaking {
      synthesizer.stopSpeaking(at: .immediate)
    }
  }

  private func handleBargeIn() {
    guard isSpeaking else { return }
    // Flush the queue through the same path stopSpeaking uses, then report.
    stopSpeakingLocked()
    emit("bargeIn", ["reason": "voice-onset"])
  }

  // MARK: - Earcon

  private func playEarconLocked() {
    guard let url = earconURL() else { return }
    do {
      let player = try AVAudioPlayer(contentsOf: url)
      earconPlayer = player
      player.play()
    } catch {
      // Fire-and-forget: a refused earcon is silent, never an event.
    }
  }

  private func earconURL() -> URL? {
    let candidates = [Bundle.main, Bundle(for: HandsfreeVoiceModule.self)]
    for bundle in candidates {
      if let url = bundle.url(forResource: "handsfree_send_earcon", withExtension: "wav") {
        return url
      }
    }
    return nil
  }

  // MARK: - Interruption / route loss

  private func observeAudioSession() {
    let center = NotificationCenter.default
    interruptionObserver = center.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: nil,
      queue: .main
    ) { [weak self] note in
      guard let self = self else { return }
      guard
        let info = note.userInfo,
        let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
        let type = AVAudioSession.InterruptionType(rawValue: raw),
        type == .began
      else { return }
      self.audioQueue.async {
        guard self.sessionActive else { return }
        self.emit("interruption", ["reason": "audio-session"])
        self.end(reason: "system-interruption")
      }
    }
    routeObserver = center.addObserver(
      forName: AVAudioSession.routeChangeNotification,
      object: nil,
      queue: .main
    ) { [weak self] note in
      guard let self = self else { return }
      guard
        let info = note.userInfo,
        let raw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
        let reason = AVAudioSession.RouteChangeReason(rawValue: raw),
        reason == .oldDeviceUnavailable
      else { return }
      // A headset going away is fatal to the call rather than a silent switch
      // to the built-in microphone.
      self.audioQueue.async {
        guard self.sessionActive else { return }
        self.emit("interruption", ["reason": "route-change"])
        self.end(reason: "system-interruption")
      }
    }
  }

  private func removeObservers() {
    let center = NotificationCenter.default
    if let observer = interruptionObserver { center.removeObserver(observer) }
    if let observer = routeObserver { center.removeObserver(observer) }
    interruptionObserver = nil
    routeObserver = nil
  }

  // MARK: - Terminal transition

  public func teardown(reason: String) {
    end(reason: reason)
  }

  private func end(reason: String) {
    audioQueue.async { self.endLocked(reason: reason) }
  }

  private func endLocked(reason: String) {
    // Supersede any start still waiting on a permission answer, then tear the
    // live session down. Clearing even when inactive is what makes a late
    // grant resolve "unavailable" instead of activating audio.
    self.startAttemptId = nil
    // Cleared before the inactive early return: this flag is per-call state
    // with no writer other than `setMuted`, so letting it survive any end -
    // even the one that runs when no call was live - is exactly how a muted
    // call poisons the next one.
    self.isMuted = false
    self.consecutiveRecognitionErrors = 0
    guard self.sessionActive else { return }
    self.sessionActive = false
    self.destroyed = true
    self.stopListeningLocked()
    self.stopSpeakingLocked()
    if let engine = self.audioEngine {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
    }
    self.audioEngine = nil
    self.speechRecognizer = nil
    self.earconPlayer?.stop()
    self.earconPlayer = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
  }

  // MARK: - Events

  private func emit(_ name: String, _ body: [String: Any?] = [:]) {
    DispatchQueue.main.async { [weak self] in
      self?.sendEvent(name, body)
    }
  }

  private func emitLevel(_ level: Float, now: TimeInterval) {
    guard now - lastLevelEmit >= 0.1 else { return }
    lastLevelEmit = now
    emit("level", ["level": Double(level)])
  }
}

/// The synthesizer delegate that advances the chunk queue. Kept separate
/// because `AVSpeechSynthesizerDelegate` requires an `NSObject`, which the
/// Expo module base class is not.
private final class HandsfreeSpeechDelegate: NSObject, AVSpeechSynthesizerDelegate {
  private let onFinish: (AVSpeechUtterance) -> Void

  init(onFinish: @escaping (AVSpeechUtterance) -> Void) {
    self.onFinish = onFinish
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    onFinish(utterance)
  }
}
