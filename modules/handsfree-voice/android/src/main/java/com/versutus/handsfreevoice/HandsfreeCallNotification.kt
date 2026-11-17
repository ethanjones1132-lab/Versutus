package com.versutus.handsfreevoice

/**
 * The hands-free call's ongoing-notification facts, held pure (no Android
 * framework calls) so the copy and the action recognition the service renders
 * stay unit-testable on the JVM, the way [HandsfreeCallState] is.
 *
 * The service's `buildNotification` reads the title, caller name, body and
 * action labels from here, and reposts the notification whenever the phase
 * facts it holds change.
 */
internal object HandsfreeCallNotification {
  /**
   * The neutral body line: what a call is doing when none of the words below
   * are held — a phone engine between turns, a Gate call before its first phase
   * frame, or a phase the service cannot see. It answers this line, never a
   * guess.
   */
  const val TEXT = "Hands-free call in progress"

  // The state words the body line can carry. Each is one word, so the lock
  // screen says what the call is doing without exposing a message: the body
  // never holds a transcript, a reply or a thread name.
  /** The microphone is open and the call is hearing the operator. */
  const val LISTENING = "Listening"
  /** The turn has left the phone and the call is waiting on the reply. */
  const val THINKING = "Thinking"
  /** The reply is being spoken to the operator. */
  const val SPEAKING = "Speaking"
  /** The operator closed the microphone; the call is still up. */
  const val MUTED = "Muted"
  /** The call audio link is being re-established; the call is still up. */
  const val RECONNECTING = "Reconnecting"

  /** The call's own name, used when no Bot/surface label was given. */
  const val CALL_NAME = "Hands-free call"

  /** The terminal action's label; the service attaches the intent. */
  const val END_ACTION_LABEL = "End call"

  /**
   * The title the notification carries: the call, plus the Bot/surface label
   * the operator tapped Start on. A blank label is dropped rather than
   * rendering a dangling "with".
   */
  fun titleFor(label: String): String =
    if (label.isBlank()) CALL_NAME else "$CALL_NAME with $label"

  /**
   * The name the notification's caller is shown under. CallStyle renders a
   * `Person`, not a title, so the operator reads "who" as the person on the
   * other end of the call; a blank label answers the call's own name, never an
   * empty caller that the platform would refuse.
   */
  fun callerFor(label: String): String = if (label.isBlank()) CALL_NAME else label.trim()

  /**
   * The body line: what the call is doing right now, from the phase facts the
   * service itself holds. Mute wins (the operator's own choice outranks what
   * the call is doing), then a link being rebuilt, then the word a Gate call's
   * own phase frame named, then speech, recognition, and finally a turn in
   * flight. None of them active answers the neutral [TEXT], never "listening
   * through the microphone" for a call holding neither.
   */
  fun bodyFor(
    muted: Boolean,
    listening: Boolean,
    speaking: Boolean,
    thinking: Boolean = false,
    reconnecting: Boolean = false,
    gateWord: String? = null,
  ): String =
    when {
      muted -> MUTED
      reconnecting -> RECONNECTING
      // The Gate holds a call's loop, so its own phase frame is the word for
      // the half the phone does not run — it beats the phone recognizer's
      // flags, which stay false under a Gate call.
      gateWord != null -> gateWord
      speaking -> SPEAKING
      listening -> LISTENING
      thinking -> THINKING
      else -> TEXT
    }

  /**
   * The word one Gate → phone frame names, or null when it names none.
   *
   * A Gate call is driven on the Gate: the frames it sends are the only
   * evidence the phone has of what the call is doing, so the notification
   * follows them rather than the phone recognizer's own flags. `phase` carries
   * the Gate's whole vocabulary; a `speech` start is the reply beginning to
   * play and its end is the call going back to hearing the operator.
   *
   * `opening`, `speech/cancelled` and `speech/gap` answer null: the call has
   * not settled on a word there, and the word already shown stands until the
   * Gate's next frame names one.
   */
  fun wordForGateFrame(frame: GateFrame): String? = when (frame) {
    is GateFrame.Phase -> wordForGatePhase(frame.phase)
    is GateFrame.Speech -> wordForSpeechState(frame.state)
    else -> null
  }

  /** The word a Gate `phase` names; null for a phase with no word (`opening`). */
  fun wordForGatePhase(phase: String): String? = when (phase) {
    "listening" -> LISTENING
    "thinking" -> THINKING
    "speaking" -> SPEAKING
    "muted" -> MUTED
    else -> null
  }

  /** The word a Gate `speech` state asks for; null leaves the shown word alone. */
  fun wordForSpeechState(state: String): String? = when (state) {
    "start" -> SPEAKING
    "end" -> LISTENING
    else -> null
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

/**
 * The word the ongoing notification was last posted with, and the rule that
 * only a changed word posts again.
 *
 * A Gate call sends `phase` and `speech` frames in bursts — a listening phase
 * after every turn, a speech start and its end around every reply — and each
 * one names the word the body line carries. Posting for each of them redraws
 * the notification (and, on some ROMs, works the main thread) for no visible
 * change. Kept out of the service so the rule is proved on the JVM without a
 * NotificationManager.
 */
internal class HandsfreeCallWord {
  private var shown: String? = null

  /** The word on screen, or null before this call's first post. */
  fun current(): String? = shown

  /** True only when [word] differs from the one shown; remembers it either way. */
  fun changedTo(word: String): Boolean {
    val changed = shown != word
    shown = word
    return changed
  }

  /** Records the word a post carried, so a later frame that repeats it is quiet. */
  fun remember(word: String) {
    shown = word
  }

  /** Forgets the word, so a new call's first frame posts. */
  fun reset() {
    shown = null
  }
}
