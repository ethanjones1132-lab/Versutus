package com.versutus.handsfreevoice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HandsfreeGateMediaOwnerTest {
  @Test fun mutePersistsBeforeAttachAndANewCallStartsUnmuted() {
    HandsfreeGateMediaOwner.stop()
    HandsfreeGateMediaOwner.beginCall()
    HandsfreeGateMediaOwner.setMuted(true)
    val media = HandsfreeGateMedia({}, initiallyMuted = HandsfreeGateMediaOwner.isMuted())
    HandsfreeGateMediaOwner.attach(media)
    assertTrue(media.isMuted())

    HandsfreeGateMediaOwner.stop()
    HandsfreeGateMediaOwner.beginCall()
    assertFalse(HandsfreeGateMediaOwner.isMuted())
    HandsfreeGateMediaOwner.stop()
  }

  @Test fun mediaAttachedAfterCallClosedIsStoppedImmediately() {
    HandsfreeGateMediaOwner.stop()
    val media = HandsfreeGateMedia({})
    HandsfreeGateMediaOwner.attach(media)
    assertTrue(media.isStopped())
  }

  @Test fun theCallListenerHearsFramesAndLinkLossUntilTheCallStops() {
    HandsfreeGateMediaOwner.stop()
    HandsfreeGateMediaOwner.beginCall()
    val words = mutableListOf<String?>()
    var lost = 0
    HandsfreeGateMediaOwner.watch(object : HandsfreeGateMediaListener {
      override fun onGateFrame(frame: GateFrame) {
        words.add(HandsfreeCallNotification.wordForGateFrame(frame))
      }

      override fun onGateLinkLost() {
        lost += 1
      }
    })
    HandsfreeGateMediaOwner.reportFrame(GateFrame.Phase("listening"))
    HandsfreeGateMediaOwner.reportLinkLost()
    assertEquals(listOf(HandsfreeCallNotification.LISTENING), words)
    assertEquals(1, lost)
    // The call is over: a media instance that outlives it must not paint its
    // frames onto the next call's notification.
    HandsfreeGateMediaOwner.stop()
    HandsfreeGateMediaOwner.reportFrame(GateFrame.Phase("speaking"))
    HandsfreeGateMediaOwner.reportLinkLost()
    assertEquals(1, words.size)
    assertEquals(1, lost)
  }
}
