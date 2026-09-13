package com.versutus.handsfreevoice

import android.speech.SpeechRecognizer

/** What a call does about one recognizer error. Pure, so it is JVM-tested. */
object HandsfreeRecognizerErrors {
  enum class Action { RESTART, RETRY_LATER, FATAL }

  const val MAX_TRANSIENT_FAILURES = 3

  fun classify(code: Int, consecutiveFailures: Int): Action = when (code) {
    SpeechRecognizer.ERROR_NO_MATCH,
    SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> Action.RESTART

    SpeechRecognizer.ERROR_CLIENT,
    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> Action.RETRY_LATER

    SpeechRecognizer.ERROR_NETWORK,
    SpeechRecognizer.ERROR_NETWORK_TIMEOUT,
    SpeechRecognizer.ERROR_SERVER,
    SpeechRecognizer.ERROR_SERVER_DISCONNECTED,
    SpeechRecognizer.ERROR_TOO_MANY_REQUESTS ->
      if (consecutiveFailures < MAX_TRANSIENT_FAILURES) Action.RETRY_LATER else Action.FATAL

    SpeechRecognizer.ERROR_AUDIO,
    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS,
    SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED,
    SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> Action.FATAL

    else -> if (consecutiveFailures < MAX_TRANSIENT_FAILURES) Action.RETRY_LATER else Action.FATAL
  }
}
