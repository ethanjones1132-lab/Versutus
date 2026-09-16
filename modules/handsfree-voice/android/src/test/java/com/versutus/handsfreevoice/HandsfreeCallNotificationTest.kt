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
  fun theBodyLineIsWhatTheCallIsDoingRightNow() {
    // The body answers what the service actually holds, never a blanket claim.
    assertEquals("Listening", HandsfreeCallNotification.bodyFor(false, true, false))
    assertEquals("Speaking", HandsfreeCallNotification.bodyFor(false, false, true))
    assertEquals("Muted", HandsfreeCallNotification.bodyFor(true, false, false))
    assertEquals("Muted", HandsfreeCallNotification.bodyFor(true, true, true))
    // None of the service-visible phases active means the turn is sending or
    // the reply is incoming — phases only JS knows, so the neutral line stands
    // and never claims the microphone.
    assertEquals(
      "Hands-free call in progress",
      HandsfreeCallNotification.bodyFor(false, false, false),
    )
  }

  @Test
  fun theEndActionIsLabelledEndCall() {
    assertEquals("End call", HandsfreeCallNotification.END_ACTION_LABEL)
  }

  @Test
  fun onlyTheServiceEndActionIsTheEndAction() {
    assertTrue(HandsfreeCallNotification.isEndAction(HandsfreeCallService.ACTION_END))
    assertFalse(HandsfreeCallNotification.isEndAction(null))
    assertFalse(HandsfreeCallNotification.isEndAction("com.versutus.handsfreevoice.action.OTHER"))
  }

  @Test
  fun theEndActionReachesTheStateMachineExactlyOnce() {
    // The path the notification's End drives: a service intent holding
    // ACTION_END is judged by isEndAction and drives the state machine's
    // terminal transition. The first End wins; every later one is refused.
    val state = HandsfreeCallState()
    assertTrue(state.start())
    assertTrue(HandsfreeCallNotification.isEndAction(HandsfreeCallService.ACTION_END))
    assertTrue(state.requestEnd("user"))
    assertEquals("user", state.endReason())
    assertEquals(HandsfreeCallState.Phase.ENDED, state.phase)
    // A second End intent (double-tap, or the task-removed race) is refused.
    assertFalse(state.requestEnd("user"))
    assertEquals("user", state.endReason())
  }

  @Test
  fun theMuteActionLabelFollowsTheStateTheServiceHolds() {
    // The action's label offers the state the tap will reach: a live call
    // offers Mute, a muted one offers Unmute. The body already reports the
    // state held ("Muted"), so the label never argues with it.
    assertEquals("Mute", HandsfreeCallNotification.muteActionLabelFor(false))
    assertEquals("Unmute", HandsfreeCallNotification.muteActionLabelFor(true))
  }

  @Test
  fun onlyTheServiceMuteActionsAreTheMuteActions() {
    assertTrue(HandsfreeCallNotification.isMuteAction(HandsfreeCallService.ACTION_MUTE))
    assertTrue(HandsfreeCallNotification.isMuteAction(HandsfreeCallService.ACTION_UNMUTE))
    assertFalse(HandsfreeCallNotification.isMuteAction(HandsfreeCallService.ACTION_END))
    assertFalse(HandsfreeCallNotification.isMuteAction(null))
    assertFalse(HandsfreeCallNotification.isMuteAction("com.versutus.handsfreevoice.action.OTHER"))
  }

  @Test
  fun theMuteIntentNamesTheStateItWants() {
    // Each action names exactly one state, so a tap cannot silently ask for
    // what the service already holds.
    assertEquals(false, HandsfreeCallNotification.mutedForAction(HandsfreeCallService.ACTION_MUTE))
    assertEquals(true, HandsfreeCallNotification.mutedForAction(HandsfreeCallService.ACTION_UNMUTE))
    // An End or unknown action is not a mute request, not a mute-to-false.
    assertEquals(null, HandsfreeCallNotification.mutedForAction(HandsfreeCallService.ACTION_END))
    assertEquals(null, HandsfreeCallNotification.mutedForAction("junk"))
    assertEquals(null, HandsfreeCallNotification.mutedForAction(null))
  }

  @Test
  fun theMuteActionDrivesTheSameStateTheServiceHolds() {
    // The path the notification's Mute drives: the judged action names a
    // state, the machine mutes only a live call, and the label the next
    // repost draws offers the state the call will reach — so a muted call
    // offers Unmute without a second tap guessing.
    val state = HandsfreeCallState()
    assertTrue(state.start())
    assertTrue(HandsfreeCallNotification.mutedForAction(HandsfreeCallService.ACTION_MUTE) == false)
    assertTrue(state.setMuted(true))
    assertEquals(
      "Unmute",
      HandsfreeCallNotification.muteActionLabelFor(state.muted),
    )
    // Unmuting from the notification asks for false and lands there.
    assertTrue(HandsfreeCallNotification.mutedForAction(HandsfreeCallService.ACTION_UNMUTE) == true)
    assertTrue(state.setMuted(false))
    assertEquals(
      "Mute",
      HandsfreeCallNotification.muteActionLabelFor(state.muted),
    )
    // After End the mute actions do nothing: only End is terminal, and it
    // already happened — the second ask is refused like the second End.
    assertTrue(state.requestEnd("user"))
    assertFalse(state.setMuted(true))
    assertFalse(state.setMuted(false))
  }
}
