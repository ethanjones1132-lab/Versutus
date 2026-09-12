import Foundation

/// Endpointing policy for one utterance turn on iOS.
///
/// The module feeds this an amplitude per audio buffer; it owns the adaptive
/// noise floor and the thresholds. It is pure Foundation so the XCTest bundle
/// can exercise it without an audio session, and its numbers mirror the Android
/// `HandsfreeEndpointing.kt` so both platforms answer the same questions with
/// the same values.
public final class HandsfreeEndpointing {
  public enum Silence {
    case final
    case noSpeech
  }

  /// Complete silence: a sentence that has clearly finished.
  public static let completeSilenceMs: TimeInterval = 0.9
  /// No speech at all for this long means nothing is coming this turn.
  public static let noSpeechTimeoutMs: TimeInterval = 10
  /// No utterance may run longer than this before it is force-finished.
  public static let utteranceCeilingMs: TimeInterval = 60

  private let completeSilence: TimeInterval
  private let noSpeechTimeout: TimeInterval
  private let utteranceCeiling: TimeInterval

  private var turnStartedAt: TimeInterval?
  private var lastVoiceAt: TimeInterval?
  private var heardSpeech = false

  /// The running estimate of ambient level, adapted upward only slowly so a
  /// single door-slam cannot raise the floor above the operator's voice.
  private var noiseFloor: Float = 0

  public init(
    completeSilenceMs: TimeInterval = HandsfreeEndpointing.completeSilenceMs,
    noSpeechTimeoutMs: TimeInterval = HandsfreeEndpointing.noSpeechTimeoutMs,
    utteranceCeilingMs: TimeInterval = HandsfreeEndpointing.utteranceCeilingMs
  ) {
    self.completeSilence = completeSilenceMs
    self.noSpeechTimeout = noSpeechTimeoutMs
    self.utteranceCeiling = utteranceCeilingMs
  }

  /// Start a fresh turn; the previous turn's observations are discarded.
  public func begin(at now: TimeInterval) {
    turnStartedAt = now
    lastVoiceAt = nil
    heardSpeech = false
  }

  /// Forget the current turn entirely (a stopped or cancelled recognition).
  public func reset() {
    turnStartedAt = nil
    lastVoiceAt = nil
    heardSpeech = false
  }

  /// Voice crossed the noise floor; remembers it as the last heard moment.
  public func onVoice(at now: TimeInterval) {
    guard turnStartedAt != nil else { return }
    lastVoiceAt = now
    heardSpeech = true
  }

  public var hasHeardSpeech: Bool { heardSpeech }

  /// The 60-second ceiling, measured from the turn's start.
  public func isPastCeiling(at now: TimeInterval) -> Bool {
    guard let started = turnStartedAt else { return false }
    return now - started >= utteranceCeiling
  }

  /// No speech at all within the no-speech window.
  public func noSpeechTimedOut(at now: TimeInterval) -> Bool {
    guard let started = turnStartedAt, !heardSpeech else { return false }
    return now - started >= noSpeechTimeout
  }

  /// Whether a silence-triggered finish is due: speech was heard and the
  /// complete-silence window has elapsed since the last voice.
  public func shouldFinishForSilence(at now: TimeInterval) -> Bool {
    guard heardSpeech, let last = lastVoiceAt else { return false }
    return now - last >= completeSilence
  }

  /// Whether the turn ended on silence without ever hearing speech.
  public func classifySilence() -> Silence {
    heardSpeech ? .final : .noSpeech
  }

  /// Fold one buffer's amplitude into the adaptive noise floor. Called for
  /// every buffer, including while recognition is not running.
  public func updateNoiseFloor(_ level: Float) {
    if noiseFloor == 0 {
      noiseFloor = max(level, HandsfreeEndpointing.minimumFloor)
    } else {
      noiseFloor = noiseFloor * (1 - HandsfreeEndpointing.floorAdapt) + level * HandsfreeEndpointing.floorAdapt
    }
  }

  /// Whether one buffer's amplitude reads as voice rather than ambience.
  public func isVoice(_ level: Float) -> Bool {
    let threshold = max(noiseFloor * HandsfreeEndpointing.onsetFactor, HandsfreeEndpointing.minimumFloor)
    return level > threshold
  }

  private static let minimumFloor: Float = 0.01
  private static let floorAdapt: Float = 0.02
  private static let onsetFactor: Float = 3.0
}
