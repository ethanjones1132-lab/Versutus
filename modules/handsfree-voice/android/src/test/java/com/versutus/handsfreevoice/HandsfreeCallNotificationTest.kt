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
    // None of the service-visible phases active means a Gate call, whose audio
    // the service does not phase, so the neutral line stands and never claims
    // the microphone.
    assertEquals(
      "Hands-free call in progress",
      HandsfreeCallNotification.bodyFor(false, false, false),
    )
  }

  @Test
  fun theBodyLineNamesEveryStateTheCallCanBeIn() {
    // The five state words the lock screen reads at a glance: what the call is
    // doing, in one word, never a transcript, a reply or a thread name.
    assertEquals(
      "Listening",
      HandsfreeCallNotification.bodyFor(false, true, false),
    )
    assertEquals(
      "Thinking",
      HandsfreeCallNotification.bodyFor(false, false, false, thinking = true),
    )
    assertEquals(
      "Speaking",
      HandsfreeCallNotification.bodyFor(false, false, true),
    )
    assertEquals(
      "Muted",
      HandsfreeCallNotification.bodyFor(true, false, false),
    )
    assertEquals(
      "Reconnecting",
      HandsfreeCallNotification.bodyFor(false, false, false, reconnecting = true),
    )
    // The words are the constants the service draws, so a rename cannot leave
    // the body and its tests describing two different calls.
    assertEquals(HandsfreeCallNotification.LISTENING, HandsfreeCallNotification.bodyFor(false, true, false))
    assertEquals(
      HandsfreeCallNotification.THINKING,
      HandsfreeCallNotification.bodyFor(false, false, false, thinking = true),
    )
    assertEquals(HandsfreeCallNotification.SPEAKING, HandsfreeCallNotification.bodyFor(false, false, true))
    assertEquals(HandsfreeCallNotification.MUTED, HandsfreeCallNotification.bodyFor(true, false, false))
    assertEquals(
      HandsfreeCallNotification.RECONNECTING,
      HandsfreeCallNotification.bodyFor(false, false, false, reconnecting = true),
    )
  }

  @Test
  fun theOperatorChoiceOutranksWhatTheCallIsDoing() {
    // Mute is the operator's decision, so it answers even while the link is
    // being rebuilt or a reply would otherwise be speaking.
    assertEquals(
      "Muted",
      HandsfreeCallNotification.bodyFor(true, true, true, thinking = true, reconnecting = true),
    )
    // A link being rebuilt outranks a leftover speaking/listening flag: the
    // audio is not flowing, which is the thing worth naming.
    assertEquals(
      "Reconnecting",
      HandsfreeCallNotification.bodyFor(false, true, true, thinking = true, reconnecting = true),
    )
    // Speech outranks recognition, and recognition outranks a turn in flight.
    assertEquals(
      "Speaking",
      HandsfreeCallNotification.bodyFor(false, true, true, thinking = true),
    )
    assertEquals(
      "Listening",
      HandsfreeCallNotification.bodyFor(false, true, false, thinking = true),
    )
    // A turn in flight is named, but never as the microphone hearing: the call
    // is waiting on the reply.
    assertEquals(
      "Thinking",
      HandsfreeCallNotification.bodyFor(false, false, false, thinking = true),
    )
  }

  @Test
  fun theCallerIsTheBotLabelWithTheCallItsOwnFallbackName() {
    // CallStyle draws a Person, not a title: the caller is the label itself,
    // trimmed, so the lock screen reads "Sam" as the other end of the call.
    assertEquals("Sam", HandsfreeCallNotification.callerFor("Sam"))
    assertEquals("Sam", HandsfreeCallNotification.callerFor("  Sam  "))
    // A blank label uses the call's own name; the platform refuses an empty
    // caller, and a blank bubble with no name reads as a broken call.
    assertEquals("Hands-free call", HandsfreeCallNotification.callerFor(""))
    assertEquals("Hands-free call", HandsfreeCallNotification.callerFor("   "))
    // The caller and the title describe the same call: the label appears once
    // as the person, and the title says what the notification is.
    assertEquals(
      "Hands-free call with Sam",
      HandsfreeCallNotification.titleFor("Sam"),
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
    // what the service already holds: Mute asks for a muted call, Unmute for a
    // live microphone.
    assertEquals(true, HandsfreeCallNotification.mutedForAction(HandsfreeCallService.ACTION_MUTE))
    assertEquals(false, HandsfreeCallNotification.mutedForAction(HandsfreeCallService.ACTION_UNMUTE))
    // An End or unknown action is not a mute request, not a mute-to-false.
    assertEquals(null, HandsfreeCallNotification.mutedForAction(HandsfreeCallService.ACTION_END))
    assertEquals(null, HandsfreeCallNotification.mutedForAction("junk"))
    assertEquals(null, HandsfreeCallNotification.mutedForAction(null))
  }

  @Test
  fun theMuteIntentAttachedAsksForTheStateItsLabelNames() {
    // The label and the intent the notification attaches are one decision, and
    // the intent asks for the state the label NAMES — the opposite of the state
    // the label was drawn from.
    assertEquals("Mute", HandsfreeCallNotification.muteActionLabelFor(false))
    assertEquals(HandsfreeCallService.ACTION_MUTE, HandsfreeCallNotification.muteActionFor(false))
    assertEquals(
      true,
      HandsfreeCallNotification.mutedForAction(HandsfreeCallNotification.muteActionFor(false)),
    )

    assertEquals("Unmute", HandsfreeCallNotification.muteActionLabelFor(true))
    assertEquals(HandsfreeCallService.ACTION_UNMUTE, HandsfreeCallNotification.muteActionFor(true))
    assertEquals(
      false,
      HandsfreeCallNotification.mutedForAction(HandsfreeCallNotification.muteActionFor(true)),
    )
  }

  @Test
  fun everyMuteActionTheNotificationAttachesFlipsTheMuteState() {
    // The tap end to end, driven the way buildNotification builds it and
    // onStartCommand handles it: the label and the intent it attaches, the
    // intent through mutedForAction, and that answer applied to the machine.
    // Invert either step — the table, or the intent attached — and the state
    // stays where it was, which is how a "Mute" button shipped that left the
    // microphone live.
    for (muted in listOf(false, true)) {
      val state = HandsfreeCallState()
      assertTrue(state.start())
      assertTrue(state.setMuted(muted))
      val label = HandsfreeCallNotification.muteActionLabelFor(state.muted)
      val action = HandsfreeCallNotification.muteActionFor(state.muted)
      assertEquals(if (muted) "Unmute" else "Mute", label)
      assertTrue(HandsfreeCallNotification.isMuteAction(action))

      // The tap, as the service performs it, reaches the state the label named.
      val asked = HandsfreeCallNotification.mutedForAction(action)!!
      assertTrue(state.setMuted(asked))
      assertEquals(!muted, state.muted)
      // The reposted label offers the way back, and taking it returns the call
      // to the state it started in: neither direction is ever a no-op.
      assertEquals(if (muted) "Mute" else "Unmute", HandsfreeCallNotification.muteActionLabelFor(state.muted))
      assertTrue(
        state.setMuted(
          HandsfreeCallNotification.mutedForAction(
            HandsfreeCallNotification.muteActionFor(state.muted),
          )!!,
        ),
      )
      assertEquals(muted, state.muted)
    }
  }

  @Test
  fun theMuteActionDrivesTheSameStateTheServiceHolds() {
    // The path the notification's Mute drives: the judged action names a state,
    // and that state — the mapping's own answer, never a value supplied by hand
    // — is what the machine is given. The machine mutes only a live call, and
    // the label the next repost draws offers the state the call will reach, so
    // a muted call offers Unmute without a second tap guessing.
    val state = HandsfreeCallState()
    assertTrue(state.start())
    assertTrue(
      state.setMuted(HandsfreeCallNotification.mutedForAction(HandsfreeCallService.ACTION_MUTE)!!),
    )
    assertTrue(state.muted)
    assertEquals(
      "Unmute",
      HandsfreeCallNotification.muteActionLabelFor(state.muted),
    )
    // Unmuting from the notification asks for false and lands there.
    assertTrue(
      state.setMuted(HandsfreeCallNotification.mutedForAction(HandsfreeCallService.ACTION_UNMUTE)!!),
    )
    assertFalse(state.muted)
    assertEquals(
      "Mute",
      HandsfreeCallNotification.muteActionLabelFor(state.muted),
    )
    // After End the mute actions do nothing: only End is terminal, and it
    // already happened — the second ask is refused like the second End.
    assertTrue(state.requestEnd("user"))
    assertFalse(state.setMuted(HandsfreeCallNotification.mutedForAction(HandsfreeCallService.ACTION_MUTE)!!))
    assertFalse(state.setMuted(HandsfreeCallNotification.mutedForAction(HandsfreeCallService.ACTION_UNMUTE)!!))
  }

  @Test
  fun everyGateFrameThatNamesAPhaseBecomesItsWord() {
    // A Gate call runs its loop on the Gate, so its own frames are the only
    // evidence the phone has of what the call is doing.
    assertEquals(
      HandsfreeCallNotification.LISTENING,
      HandsfreeCallNotification.wordForGateFrame(GateFrame.Phase("listening")),
    )
    assertEquals(
      HandsfreeCallNotification.THINKING,
      HandsfreeCallNotification.wordForGateFrame(GateFrame.Phase("thinking")),
    )
    assertEquals(
      HandsfreeCallNotification.SPEAKING,
      HandsfreeCallNotification.wordForGateFrame(GateFrame.Phase("speaking")),
    )
    assertEquals(
      HandsfreeCallNotification.MUTED,
      HandsfreeCallNotification.wordForGateFrame(GateFrame.Phase("muted")),
    )
    // A speech frame names the reply's own half of the loop: it starts
    // speaking, and its end is the call hearing the operator again.
    assertEquals(
      HandsfreeCallNotification.SPEAKING,
      HandsfreeCallNotification.wordForGateFrame(GateFrame.Speech(1L, "start")),
    )
    assertEquals(
      HandsfreeCallNotification.LISTENING,
      HandsfreeCallNotification.wordForGateFrame(GateFrame.Speech(1L, "end")),
    )
    // A cancelled or gapped reply, an opening call, and every frame that is not
    // about the phase name no word: the shown one stands rather than a guess.
    assertEquals(null, HandsfreeCallNotification.wordForGateFrame(GateFrame.Speech(1L, "cancelled")))
    assertEquals(null, HandsfreeCallNotification.wordForGateFrame(GateFrame.Speech(1L, "gap")))
    assertEquals(null, HandsfreeCallNotification.wordForGateFrame(GateFrame.Phase("opening")))
    assertEquals(null, HandsfreeCallNotification.wordForGateFrame(GateFrame.Ready("local", null)))
    assertEquals(null, HandsfreeCallNotification.wordForGateFrame(GateFrame.Reply("turn-1", "hi")))
  }

  @Test
  fun theGateWordIsTheWordTheBodyShows() {
    // The phone's own flags stay false under a Gate call; the Gate's phase is
    // what the lock screen reads.
    assertEquals(
      "Listening",
      HandsfreeCallNotification.bodyFor(
        false, false, false, gateWord = HandsfreeCallNotification.LISTENING,
      ),
    )
    assertEquals(
      "Thinking",
      HandsfreeCallNotification.bodyFor(
        false, false, false, gateWord = HandsfreeCallNotification.THINKING,
      ),
    )
    // The operator's Mute still outranks it...
    assertEquals(
      "Muted",
      HandsfreeCallNotification.bodyFor(
        true, false, false, gateWord = HandsfreeCallNotification.LISTENING,
      ),
    )
    // ...and so does a link being rebuilt: its audio is not flowing, which is
    // the fact worth naming over a phase from the socket that just died.
    assertEquals(
      "Reconnecting",
      HandsfreeCallNotification.bodyFor(
        false, false, false, reconnecting = true, gateWord = HandsfreeCallNotification.SPEAKING,
      ),
    )
  }

  @Test
  fun onlyAChangedWordIsWorthARepost() {
    val word = HandsfreeCallWord()
    assertTrue(word.changedTo(HandsfreeCallNotification.LISTENING))
    assertEquals(HandsfreeCallNotification.LISTENING, word.current())
    // A Gate call sends `phase: listening` after every turn; the repeated word
    // must not post the notification again.
    assertFalse(word.changedTo(HandsfreeCallNotification.LISTENING))
    assertTrue(word.changedTo(HandsfreeCallNotification.THINKING))
    assertTrue(word.changedTo(HandsfreeCallNotification.LISTENING))
    // A post made for another reason (a Mute tap, the phone engine's own
    // speech) records the word it carried, so the frame repeating it is quiet.
    word.remember(HandsfreeCallNotification.SPEAKING)
    assertFalse(word.changedTo(HandsfreeCallNotification.SPEAKING))
    // A new call starts unposted, so its first frame is never swallowed.
    word.reset()
    assertEquals(null, word.current())
    assertTrue(word.changedTo(HandsfreeCallNotification.LISTENING))
  }
}
