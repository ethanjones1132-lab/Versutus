package com.versutus.handsfreevoice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GateAttachControlsTest {
  @Test fun resumeIsFollowedByTheCurrentMuteEvenIfTheSocketDidNotCarryTheTap() {
    val capture = GateCaptureState()
    val controls = mutableListOf<GateFrame.Phone>()
    val resume: (Long) -> Boolean = { controls.add(GateFrame.Phone.Resume(it)) }
    val syncMute: () -> Boolean = { controls.add(GateFrame.Phone.Mute(capture.isMuted())) }
    // The operator used the notification while disconnected.
    capture.setMuted(true)
    assertTrue(sendGateAttachControls(true, 12L, resume, syncMute))
    assertEquals(listOf(GateFrame.Phone.Resume(12L), GateFrame.Phone.Mute(true)), controls)

    controls.clear()
    capture.setMuted(false)
    assertTrue(sendGateAttachControls(true, 15L, resume, syncMute))
    assertEquals(listOf(GateFrame.Phone.Resume(15L), GateFrame.Phone.Mute(false)), controls)
  }

  @Test fun olderGateGetsMuteWithoutAV2Resume() {
    val controls = mutableListOf<GateFrame.Phone>()
    assertTrue(sendGateAttachControls(
      protocolV2 = false,
      lastSeq = 0L,
      resume = { error("v1 does not support resume") },
      syncMute = { controls.add(GateFrame.Phone.Mute(true)) },
    ))
    assertEquals(listOf(GateFrame.Phone.Mute(true)), controls)
  }

  @Test fun rejectedResumeDoesNotQueueOutOfOrderMute() {
    assertFalse(sendGateAttachControls(true, 0L, { false }, { error("resume was not queued") }))
  }
}
