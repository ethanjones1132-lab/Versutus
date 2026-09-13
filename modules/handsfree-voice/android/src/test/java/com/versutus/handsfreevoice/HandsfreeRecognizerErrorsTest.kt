package com.versutus.handsfreevoice

import android.speech.SpeechRecognizer
import com.versutus.handsfreevoice.HandsfreeRecognizerErrors.Action
import org.junit.Assert.assertEquals
import org.junit.Test

class HandsfreeRecognizerErrorsTest {
  @Test fun silenceRestartsWithoutCountingAsAFailure() {
    assertEquals(Action.RESTART, HandsfreeRecognizerErrors.classify(SpeechRecognizer.ERROR_NO_MATCH, 99))
    assertEquals(Action.RESTART, HandsfreeRecognizerErrors.classify(SpeechRecognizer.ERROR_SPEECH_TIMEOUT, 99))
  }

  @Test fun aNetworkBlipIsRetriedThreeTimesBeforeTheCallEnds() {
    assertEquals(Action.RETRY_LATER, HandsfreeRecognizerErrors.classify(SpeechRecognizer.ERROR_NETWORK, 0))
    assertEquals(Action.RETRY_LATER, HandsfreeRecognizerErrors.classify(SpeechRecognizer.ERROR_SERVER, 2))
    assertEquals(Action.FATAL, HandsfreeRecognizerErrors.classify(SpeechRecognizer.ERROR_NETWORK_TIMEOUT, 3))
  }

  @Test fun aBusyOrCancelledRecognizerIsRetried() {
    assertEquals(Action.RETRY_LATER, HandsfreeRecognizerErrors.classify(SpeechRecognizer.ERROR_RECOGNIZER_BUSY, 5))
    assertEquals(Action.RETRY_LATER, HandsfreeRecognizerErrors.classify(SpeechRecognizer.ERROR_CLIENT, 5))
  }

  @Test fun noMicrophoneAccessOrNoLanguageEndsTheCallAtOnce() {
    assertEquals(Action.FATAL, HandsfreeRecognizerErrors.classify(SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS, 0))
    assertEquals(Action.FATAL, HandsfreeRecognizerErrors.classify(SpeechRecognizer.ERROR_AUDIO, 0))
    assertEquals(Action.FATAL, HandsfreeRecognizerErrors.classify(SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE, 0))
  }
}
