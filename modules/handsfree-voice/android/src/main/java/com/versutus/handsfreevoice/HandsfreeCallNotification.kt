package com.versutus.handsfreevoice

/**
 * The hands-free call's ongoing-notification facts, held pure (no Android
 * framework calls) so the copy and the End-action dispatch the service
 * renders stay unit-testable on the JVM, the way [HandsfreeCallState] is.
 *
 * The service's `buildNotification` reads the title/gesture from here; the
 * service's `onStartCommand` reads End recognition from here before it tells
 * JS (`endRequested`, reason user — the contract's
 * HandsfreeEndRequestedEvent) and drives [HandsfreeCallState] to its
 * terminal phase.
 */
internal object HandsfreeCallNotification {
  /** The notification body line — what the call is doing while backgrounded. */
  const val TEXT = "Listening and speaking through the microphone"

  /** The single notification action's label; the service attaches the intent. */
  const val END_ACTION_LABEL = "End call"

  /**
   * The title the notification carries: the call, plus the Bot/surface label
   * the operator tapped Start on. A blank label is dropped rather than
   * rendering a dangling "with".
   */
  fun titleFor(label: String): String =
    if (label.isBlank()) "Hands-free call" else "Hands-free call with $label"

  /** Whether an incoming service intent is the notification's End action. */
  fun isEndAction(action: String?): Boolean = action == HandsfreeCallService.ACTION_END
}
