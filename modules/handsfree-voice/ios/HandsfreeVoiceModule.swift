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

  private let audioQueue = DispatchQueue(label: "com.versutus.handsfreevoice.audio")
  private let stateLock = NSLock()

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
  private var voiceIdentifier: String?
  private var speechRate: Float?
  private var speechPitch: Float?
  private var lastPartial = ""
  private var onsetStart: TimeInterval = 0
  private var lastLevelEmit: TimeInterval = 0

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
      "level"
    )

    OnCreate {
      HandsfreeVoiceModule.current = self
      self.synthDelegate = HandsfreeSpeechDelegate { [weak self] in
        self?.audioQueue.async { self?.speakNextChunk() }
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

    AsyncFunction("startSession") { (title: String, promise: Promise) in
      self.requestAuthorization { granted in
        guard granted else {
          promise.resolve("permission-denied")
          return
        }
        do {
          try self.activateAudioSession()
        } catch {
          promise.resolve("unavailable")
          return
        }
        self.audioQueue.async {
          self.sessionActive = true
          self.destroyed = false
          if !self.startEngineIfNeeded() {
            self.audioQueue.async {
              self.sessionActive = false
            }
            DispatchQueue.main.async { promise.resolve("unavailable") }
            return
          }
          DispatchQueue.main.async { promise.resolve("started") }
        }
      }
    }

    AsyncFunction("startListening") { () -> Bool in
      guard self.sessionActive, !self.isMuted else { return false }
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
      guard self.sessionActive, !usable.isEmpty else { return false }
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

    AsyncFunction("stopSession") {
      self.audioQueue.async { self.end(reason: "user") }
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
        finishTurn(text: text)
        return
      }
      if !text.isEmpty && text != lastPartial {
        lastPartial = text
        emit("partial", ["text": text])
      }
      return
    }
    if let error = error {
      if isListening {
        // A recognition that dies mid-turn is not fatal to the call; the turn
        // closes as no speech and the next one starts fresh.
        finishTurn(text: "")
      } else {
        emit("fatalError", [
          "reason": "recognition-failed",
          "message": error.localizedDescription
        ])
        end(reason: "recognition-failed")
      }
    }
  }

  private func finishTurn(text: String) {
    isListening = false
    isFinishingTurn = false
    recognitionTask?.cancel()
    recognitionRequest = nil
    recognitionTask = nil
    endpointing.reset()
    if text.isEmpty {
      emit("noSpeech", ["reason": "silence"])
    } else {
      emit("final", ["text": text])
    }
    // Restart immediately: the JS grace window can only cancel a pending send
    // in favour of a resumed utterance if the recognizer is already listening
    // again, and restart latency otherwise clips the first syllables.
    if !isSpeaking {
      beginRecognition()
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
    // Recognition is off before speech so the reply is not heard back.
    if isListening { stopListeningLocked() }
    self.voiceIdentifier = voiceIdentifier
    self.speechRate = rate
    self.speechPitch = pitch
    speechGeneration += 1
    pendingChunks = chunks
    isSpeaking = true
    if synthesizer.isSpeaking {
      synthesizer.stopSpeaking(at: .immediate)
    }
    speakNextChunk()
  }

  private func speakNextChunk() {
    guard isSpeaking, speechGeneration > 0 else { return }
    if pendingChunks.isEmpty {
      isSpeaking = false
      onsetStart = 0
      emit("speechFinished", ["reason": "done"])
      return
    }
    let chunk = pendingChunks.removeFirst()
    let utterance = AVSpeechUtterance(string: chunk)
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

  private func stopSpeakingLocked() {
    speechGeneration += 1
    isSpeaking = false
    onsetStart = 0
    pendingChunks.removeAll()
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
    audioQueue.async {
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
  private let onFinish: () -> Void

  init(onFinish: @escaping () -> Void) {
    self.onFinish = onFinish
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    onFinish()
  }
}
