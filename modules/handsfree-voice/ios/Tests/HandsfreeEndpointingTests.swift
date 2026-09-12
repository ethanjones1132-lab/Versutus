import XCTest
@testable import HandsfreeVoice

final class HandsfreeEndpointingTests: XCTestCase {
  func testSilenceBeforeSpeechIsNoSpeech() {
    let endpointing = HandsfreeEndpointing()
    endpointing.begin(at: 0)
    XCTAssertFalse(endpointing.shouldFinishForSilence(at: 0.9))
    XCTAssertFalse(endpointing.hasHeardSpeech)
    XCTAssertEqual(endpointing.classifySilence(), .noSpeech)
  }

  func testCompleteSilenceAfterVoiceFinishesTheTurn() {
    let endpointing = HandsfreeEndpointing()
    endpointing.begin(at: 0)
    endpointing.onVoice(at: 1.0)
    XCTAssertFalse(endpointing.shouldFinishForSilence(at: 1.5))
    XCTAssertTrue(endpointing.shouldFinishForSilence(at: 1.9))
    XCTAssertEqual(endpointing.classifySilence(), .final)
  }

  func testNoSpeechTimeout() {
    let endpointing = HandsfreeEndpointing()
    endpointing.begin(at: 0)
    XCTAssertFalse(endpointing.noSpeechTimedOut(at: 9.9))
    XCTAssertTrue(endpointing.noSpeechTimedOut(at: 10.0))
    endpointing.onVoice(at: 11.0)
    XCTAssertFalse(endpointing.noSpeechTimedOut(at: 30.0))
  }

  func testUtteranceCeiling() {
    let endpointing = HandsfreeEndpointing()
    endpointing.begin(at: 0)
    endpointing.onVoice(at: 1.0)
    XCTAssertFalse(endpointing.isPastCeiling(at: 59.9))
    XCTAssertTrue(endpointing.isPastCeiling(at: 60.0))
  }

  func testAdaptiveNoiseFloorRaisesVoiceDetection() {
    let endpointing = HandsfreeEndpointing()
    for _ in 0..<200 {
      endpointing.updateNoiseFloor(0.02)
    }
    XCTAssertFalse(endpointing.isVoice(0.03))
    XCTAssertTrue(endpointing.isVoice(0.5))
  }

  func testResetForgetsTheTurn() {
    let endpointing = HandsfreeEndpointing()
    endpointing.begin(at: 0)
    endpointing.onVoice(at: 0.5)
    endpointing.reset()
    XCTAssertFalse(endpointing.hasHeardSpeech)
    XCTAssertFalse(endpointing.isPastCeiling(at: 100))
  }
}
