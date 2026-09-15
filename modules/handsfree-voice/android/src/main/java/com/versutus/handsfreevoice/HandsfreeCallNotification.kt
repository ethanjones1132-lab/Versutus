package com.versutus.handsfreevoice

/**
 * The hands-free call's ongoing-notification facts, held pure (no Android
 * framework calls) so the copy and the End-action recognition the service
 * renders stay unit-testable on the JVM, the way [HandsfreeCallState] is.
 *
 * The service's `buildNotification` reads the title, body and End label from
 * here, and reposts the notification whenever the phase facts it holds change.
 */
internal object HandsfreeCallNotification {
  /**
   * The neutral body line: what a call is doing from the service's side when
   * none of its visible phases are active (a turn sending, a reply incoming, or
   * a Gate call, whose audio the service does not phase). A phase the service
   * cannot see answers this line, never a guess.
   */
  const val TEXT = "Hands-free call in progress"

  /** The single notification action's label; the service attaches the intent. */
  const val END_ACTION_LABEL = "End call"

  /**
   * The title the notification carries: the call, plus the Bot/surface label
   * the operator tapped Start on. A blank label is dropped rather than
   * rendering a dangling "with".
   */
  fun titleFor(label: String): String =
    if (label.isBlank()) "Hands-free call" else "Hands-free call with $label"

  /**
   * The body line: what the call is doing right now, from the phase facts the
   * service itself holds. Mute wins, then speech, then recognition; none of
   * them active answers the neutral [TEXT], never "listening through the
   * microphone" for a call holding neither.
   */
  fun bodyFor(muted: Boolean, listening: Boolean, speaking: Boolean): String =
    when {
      muted -> "Muted"
      speaking -> "Speaking"
      listening -> "Listening"
      else -> TEXT
    }

  /** Whether an incoming service intent is the notification's End action. */
  fun isEndAction(action: String?): Boolean = action == HandsfreeCallService.ACTION_END
}
