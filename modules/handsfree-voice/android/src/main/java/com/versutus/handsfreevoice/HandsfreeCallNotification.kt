package com.versutus.handsfreevoice

/**
 * The hands-free call's ongoing-notification facts, held pure (no Android
 * framework calls) so the copy and the action recognition the service renders
 * stay unit-testable on the JVM, the way [HandsfreeCallState] is.
 *
 * The service's `buildNotification` reads the title, body and action labels
 * from here, and reposts the notification whenever the phase facts it holds
 * change.
 */
internal object HandsfreeCallNotification {
  /**
   * The neutral body line: what a call is doing from the service's side when
   * none of its visible phases are active (a turn sending, a reply incoming, or
   * a Gate call, whose audio the service does not phase). A phase the service
   * cannot see answers this line, never a guess.
   */
  const val TEXT = "Hands-free call in progress"

  /** The terminal action's label; the service attaches the intent. */
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

  /**
   * The Mute action's label, following the state the service holds: a live
   * call offers Mute, a muted one offers Unmute — the tap names the state it
   * will reach, and never argues with the body line that reports the state
   * held.
   */
  fun muteActionLabelFor(muted: Boolean): String = if (muted) "Unmute" else "Mute"

  /**
   * The intent the notification attaches beside [muteActionLabelFor]'s label:
   * the action that asks for the state that label names, so a tap carries the
   * intent its own label promises. Kept here, next to the label, so the pair
   * the service renders is one decision rather than two that can disagree.
   */
  fun muteActionFor(muted: Boolean): String =
    if (muted) HandsfreeCallService.ACTION_UNMUTE else HandsfreeCallService.ACTION_MUTE

  /** Whether an incoming service intent is the notification's End action. */
  fun isEndAction(action: String?): Boolean = action == HandsfreeCallService.ACTION_END

  /** Whether an incoming service intent is one of the notification's Mute actions. */
  fun isMuteAction(action: String?): Boolean =
    mutedForAction(action) != null

  /** The state an incoming Mute/Unmute intent asks for; null is not a mute request. */
  fun mutedForAction(action: String?): Boolean? =
    when (action) {
      // The other half of [muteActionFor], and the reason the two live side by
      // side: the action the notification attaches for a state must ask for
      // that state. Inverted here, a tap writes the value the call already
      // holds — the microphone stays live under a "Mute" button.
      HandsfreeCallService.ACTION_MUTE -> true
      HandsfreeCallService.ACTION_UNMUTE -> false
      else -> null
    }
}
