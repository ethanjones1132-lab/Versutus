package com.versutus.handsfreevoice

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
}
