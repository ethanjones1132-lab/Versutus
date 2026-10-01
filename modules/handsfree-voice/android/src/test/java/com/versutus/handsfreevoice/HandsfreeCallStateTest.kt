package com.versutus.handsfreevoice

import android.app.Service
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HandsfreeCallStateTest {
  @Test
  fun startsOnlyOnce() {
    val state = HandsfreeCallState()
    assertEquals(HandsfreeCallState.Phase.IDLE, state.phase)
    assertTrue(state.start())
    assertEquals(HandsfreeCallState.Phase.ACTIVE, state.phase)
    assertFalse(state.start())
  }

  @Test
  fun muteIsOnlyMeaningfulWhileActive() {
    val state = HandsfreeCallState()
    assertFalse(state.setMuted(true))
    state.start()
    assertTrue(state.setMuted(true))
    assertTrue(state.muted)
    assertTrue(state.setMuted(false))
    assertFalse(state.muted)
  }

  @Test
  fun endIsIdempotentAndRecordsTheFirstReason() {
    val state = HandsfreeCallState()
    state.start()
    assertTrue(state.requestEnd("user"))
    assertEquals("user", state.endReason())
    assertEquals(HandsfreeCallState.Phase.ENDED, state.phase)
    // Repeat End, plus the other paths: focus loss and task removal.
    assertFalse(state.requestEnd("focus-loss"))
    assertFalse(state.requestEnd("app-killed"))
    assertEquals("user", state.endReason())
  }

  @Test
  fun endBeforeStartIsRefused() {
    val state = HandsfreeCallState()
    assertFalse(state.requestEnd("user"))
    assertEquals(HandsfreeCallState.Phase.IDLE, state.phase)
    assertNull(state.endReason())
  }

  @Test
  fun muteAfterEndIsRefused() {
    val state = HandsfreeCallState()
    state.start()
    state.requestEnd("focus-loss")
    assertFalse(state.setMuted(true))
    assertFalse(state.muted)
  }

  @Test
  fun unmuteAfterEndIsRefusedToo() {
    // End is terminal, so neither direction of mute is left to answer: a muted
    // call that ends stays muted as far as the machine is concerned, and a tap
    // on Unmute after the end writes nothing.
    val state = HandsfreeCallState()
    state.start()
    assertTrue(state.setMuted(true))
    state.requestEnd("user")
    assertFalse(state.setMuted(false))
    assertTrue(state.muted)
  }

  @Test
  fun speechIsRefusedOnceTheCallEndsOrTheServiceTearsDown() {
    // Work queued on the service's main handler can land after teardown. The
    // call may still read active on paper at that point, so the service passes
    // its own teardown flag in: speech must not be rebuilt — a TTS engine and a
    // barge-in microphone — for a call that is over.
    val state = HandsfreeCallState()
    assertFalse(state.canSpeak(false))
    assertTrue(state.start())
    assertTrue(state.canSpeak(false))
    assertFalse(state.canSpeak(true))
    assertTrue(state.requestEnd("user"))
    assertFalse(state.canSpeak(false))
  }

  @Test
  fun focusLossAndTaskRemovalBothReachTheTerminalPhase() {
    val focus = HandsfreeCallState().apply { start() }
    assertTrue(focus.requestEnd("focus-loss"))
    assertEquals(HandsfreeCallState.Phase.ENDED, focus.phase)

    val task = HandsfreeCallState().apply { start() }
    assertTrue(task.requestEnd("app-killed"))
    assertEquals(HandsfreeCallState.Phase.ENDED, task.phase)
  }

  @Test
  fun serviceIsNeverSticky() {
    assertEquals(Service.START_NOT_STICKY, HandsfreeCallState.SERVICE_START_MODE)
  }
}
