package com.versutus.handsfreevoice

import android.app.Service

/**
 * The one terminal state machine the native Android call session runs.
 *
 * End is idempotent: the UI End, the notification's End action, task removal,
 * audio-focus loss and module teardown all converge here, and the first one
 * wins. Everything after that first End is a no-op, so a service can release
 * its resources in one pass without a late focus callback tearing down a
 * session somebody already ended.
 *
 * This class is deliberately free of Android framework calls (bar the inlined
 * `START_NOT_STICKY` constant) so its transitions are unit-testable on the JVM.
 */
class HandsfreeCallState {
  enum class Phase { IDLE, ACTIVE, ENDED }

  var phase: Phase = Phase.IDLE
    private set

  var muted: Boolean = false
    private set

  private var endReason: String? = null

  val isActive: Boolean get() = phase == Phase.ACTIVE

  /** Open the session. Only the first Start wins; a second is refused. */
  fun start(): Boolean {
    if (phase != Phase.IDLE) return false
    phase = Phase.ACTIVE
    muted = false
    return true
  }

  /** Mute/unmute is only meaningful while the session is active. */
  fun setMuted(value: Boolean): Boolean {
    if (phase != Phase.ACTIVE) return false
    muted = value
    return true
  }

  /**
   * Request the single terminal transition. Answers `true` exactly once — for
   * the first End to arrive — and `false` for every later End, for an End
   * before Start, and for an End after termination.
   */
  fun requestEnd(reason: String): Boolean {
    if (phase != Phase.ACTIVE) return false
    phase = Phase.ENDED
    endReason = reason
    return true
  }

  fun endReason(): String? = endReason

  companion object {
    /**
     * The service is never restarted by the OS after process death, and never
     * redelivers an end/call intent to a fresh process. B5 forbids automatic
     * resume, so a killed call stays ended.
     */
    const val SERVICE_START_MODE: Int = Service.START_NOT_STICKY
  }
}
