package com.versutus.handsfreevoice

/** Gate sends `final` at commit, not at every worker endpoint. */
internal class GateCommitCue(private val play: () -> Unit) {
  private var lastSequence = 0L
  private var lastTurnId: String? = null

  fun accept(frame: GateFrame) {
    val sequence = frame.sequence
    if (sequence != null) {
      if (sequence <= lastSequence) return
      lastSequence = sequence
    }
    if (frame !is GateFrame.Final) return
    if (sequence != null && lastTurnId == frame.turnId) return
    lastTurnId = frame.turnId
    play()
  }
}
