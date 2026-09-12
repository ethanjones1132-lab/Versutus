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
