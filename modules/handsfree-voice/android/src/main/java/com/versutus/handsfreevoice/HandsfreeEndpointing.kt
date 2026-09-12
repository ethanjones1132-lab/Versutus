package com.versutus.handsfreevoice

/**
 * Endpointing policy for one utterance turn.
 *
 * On Android the platform recognizer owns the actual silence cutoff (the
 * thresholds are handed to it as `RecognizerIntent` extras), but this class is
 * what the service uses to enforce a hard utterance ceiling and to decide
 * whether silence should be reported as a finished turn or as no speech at
 * all. It carries no Android types, so the policy is unit-testable on the JVM.
 *
 * The adaptive voice onset / silence tracking mirrors the iOS endpointing
 * implementation (`HandsfreeEndpointing.swift`) so both platforms answer the
 * same questions with the same numbers.
 */
class HandsfreeEndpointing(
  private val completeSilenceMs: Long = COMPLETE_SILENCE_MS,
  private val possiblyCompleteSilenceMs: Long = POSSIBLY_COMPLETE_SILENCE_MS,
  private val minimumSpeechMs: Long = MINIMUM_SPEECH_MS,
  private val utteranceCeilingMs: Long = UTTERANCE_CEILING_MS,
) {
  enum class Silence { FINAL, NO_SPEECH }

  private var turnStartedAt: Long? = null
  private var lastVoiceAt: Long? = null
  private var heardSpeech = false

  /** Start a fresh turn; the previous turn's observations are discarded. */
  fun begin(now: Long) {
    turnStartedAt = now
    lastVoiceAt = null
    heardSpeech = false
  }

  /** Forget the current turn entirely (a stopped or cancelled recognition). */
  fun reset() {
    turnStartedAt = null
    lastVoiceAt = null
    heardSpeech = false
  }

  /** Voice crossed the noise floor; remembers it as the last heard moment. */
  fun onVoice(now: Long) {
    if (turnStartedAt == null) return
    lastVoiceAt = now
    heardSpeech = true
  }

  fun hasHeardSpeech(): Boolean = heardSpeech

  /** The 60-second ceiling, measured from the turn's start. */
  fun isPastCeiling(now: Long): Boolean {
    val started = turnStartedAt ?: return false
    return now - started >= utteranceCeilingMs
  }

  /**
   * Whether a silence-triggered finish is due: speech was heard and the
   * complete-silence window has elapsed since the last voice. The service uses
   * this to close a turn the platform recognizer has not closed itself.
   */
  fun shouldFinishForSilence(now: Long): Boolean {
    if (!heardSpeech) return false
    val last = lastVoiceAt ?: return false
    return now - last >= completeSilenceMs
  }

  /** Whether the turn ended on silence without ever hearing speech. */
  fun classifySilence(): Silence = if (heardSpeech) Silence.FINAL else Silence.NO_SPEECH

  /** How long since the last voice (or the turn start, before any voice). */
  fun silenceElapsed(now: Long): Long {
    val anchor = lastVoiceAt ?: turnStartedAt ?: return 0
    return now - anchor
  }

  companion object {
    /** Complete silence: a sentence that has clearly finished. */
    const val COMPLETE_SILENCE_MS = 900L
    /** Possibly-complete silence: the platform may still wait for more. */
    const val POSSIBLY_COMPLETE_SILENCE_MS = 600L
    /** Voice shorter than this is not treated as deliberate speech. */
    const val MINIMUM_SPEECH_MS = 300L
    /** No utterance may run longer than this before it is force-finished. */
    const val UTTERANCE_CEILING_MS = 60_000L
    /** No speech at all for this long means nothing is coming this turn. */
    const val NO_SPEECH_TIMEOUT_MS = 10_000L
  }
}
