package com.versutus.handsfreevoice

import android.media.AudioManager

/**
 * Which audio-focus changes end a hands-free call, held pure so the rule is
 * unit-testable on the JVM the way [HandsfreeRecognizerErrors] is.
 *
 * The call holds `AUDIOFOCUS_GAIN` for voice communication. On 2026-09-16 every
 * call ended the moment it started, reporting "another app or a phone call took
 * the audio": the system speech recognizer takes transient focus when the call
 * itself starts listening, so the service's own focus listener heard a loss it
 * had caused and hung up. That happens again at every listening restart, not
 * just the first.
 *
 * So a transient loss is judged by when it lands. Within
 * [SELF_INFLICTED_WINDOW_MS] of our own listen start it is ours and the call
 * carries on; anywhere else it is a phone call or another app, and the call
 * ends as the product contract requires. A permanent loss always ends it, and a
 * duck never does.
 */
internal object HandsfreeFocusPolicy {
  /**
   * How long after [HandsfreeCallService] starts the recognizer a transient
   * focus loss is still attributed to that start. Long enough to cover the
   * recognizer binding its audio on a slow device, short enough that a phone
   * call arriving mid-conversation still ends the call.
   */
  const val SELF_INFLICTED_WINDOW_MS = 1_500L

  /**
   * Whether [change] ends the call. [msSinceListenStart] is the time since the
   * service last started listening, or `null` when no listen start is on record
   * (speaking, or idle between turns) — there is then nothing of ours to blame.
   */
  fun endsCall(change: Int, msSinceListenStart: Long?): Boolean =
    when (change) {
      AudioManager.AUDIOFOCUS_LOSS -> true
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT ->
        msSinceListenStart == null || msSinceListenStart > SELF_INFLICTED_WINDOW_MS
      else -> false
    }
}
