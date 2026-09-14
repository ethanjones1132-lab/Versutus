package com.versutus.handsfreevoice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HandsfreeCallNotificationTest {
  @Test
  fun titleNamesTheCallAndCarriesTheBotLabel() {
    // A blank title stays exactly the bare call, no dangling "with".
    assertEquals("Hands-free call", HandsfreeCallNotification.titleFor(""))
    assertEquals("Hands-free call", HandsfreeCallNotification.titleFor("   "))
    // The label the operator tapped Start on is the notification's title tail.
    assertEquals(
      "Hands-free call with Sam",
      HandsfreeCallNotification.titleFor("Sam"),
    )
  }

  @Test
  fun theBodyLineIsWhatTheCallIsDoing() {
    assertEquals(
      "Listening and speaking through the microphone",
      HandsfreeCallNotification.TEXT,
    )
  }

  @Test
  fun theEndActionIsLabelledEndCall() {
    assertEquals("End call", HandsfreeCallNotification.END_ACTION_LABEL)
  }

  @Test
  fun onlyTheServiceEndActionIsTheEndAction() {
    assertTrue(HandsfreeCallNotification.isEndAction(HandsfreeCallService.ACTION_END))
    assertFalse(HandsfreeCallNotification.isEndAction(HandsfreeCallService.ACTION_START))
    assertFalse(HandsfreeCallNotification.isEndAction(null))
    assertFalse(HandsfreeCallNotification.isEndAction("com.versutus.handsfreevoice.action.OTHER"))
  }

  @Test
  fun theEndActionReachesTheStateMachineExactlyOnce() {
    // The path the notification's End drives: a service intent holding
    // ACTION_END is judged by isEndAction, tells JS through `endRequested`
    // with reason user, and drives the state machine's terminal transition —
    // the first End wins, every later one is refused.
    val state = HandsfreeCallState()
    assertTrue(state.start())
    // First arrival (the notification tap): accepted, and the reason the
    // bridge reported matches the type's HandsfreeEndRequestedEvent.
    assertTrue(HandsfreeCallNotification.isEndAction(HandsfreeCallService.ACTION_END))
    assertTrue(state.requestEnd("user"))
    assertEquals("user", state.endReason())
    assertEquals(HandsfreeCallState.Phase.ENDED, state.phase)
    // A second End intent (double-tap, or the task-removed race) is refused.
    assertFalse(state.requestEnd("user"))
    assertEquals("user", state.endReason())
  }
}
