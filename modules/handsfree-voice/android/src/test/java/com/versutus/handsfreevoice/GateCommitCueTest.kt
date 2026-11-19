package com.versutus.handsfreevoice

import org.junit.Assert.assertEquals
import org.junit.Test

class GateCommitCueTest {
  @Test fun onlyCommitPlaysAndReplayDoesNotPlayAgain() {
    val played = mutableListOf<String>()
    val cue = GateCommitCue { played.add("sent") }
    cue.accept(GateFrame.Partial("I was thinking").apply { sequence = 1 })
    cue.accept(GateFrame.Final("turn-1", "I was thinking.").apply { sequence = 2 })
    cue.accept(GateFrame.Phase("thinking").apply { sequence = 3 })
    cue.accept(GateFrame.Final("turn-1", "I was thinking.").apply { sequence = 2 })
    cue.accept(GateFrame.Final("turn-1", "I was thinking.").apply { sequence = 4 })
    cue.accept(GateFrame.Final("turn-2", "One more thing.").apply { sequence = 6 })
    assertEquals(listOf("sent", "sent"), played)
  }

  @Test fun legacyFinalsStillCueEvenWhenTheyReuseTheCallId() {
    var plays = 0
    val cue = GateCommitCue { plays++ }
    cue.accept(GateFrame.Final("call-1", "First thought."))
    cue.accept(GateFrame.Final("call-1", "Next thought."))
    assertEquals(2, plays)
  }
}
