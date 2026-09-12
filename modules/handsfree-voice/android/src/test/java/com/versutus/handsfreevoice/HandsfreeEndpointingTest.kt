package com.versutus.handsfreevoice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HandsfreeEndpointingTest {
  @Test
  fun configuredThresholdsMatchThePlan() {
    assertEquals(900L, HandsfreeEndpointing.COMPLETE_SILENCE_MS)
    assertEquals(600L, HandsfreeEndpointing.POSSIBLY_COMPLETE_SILENCE_MS)
    assertEquals(300L, HandsfreeEndpointing.MINIMUM_SPEECH_MS)
    assertEquals(60_000L, HandsfreeEndpointing.UTTERANCE_CEILING_MS)
    assertEquals(10_000L, HandsfreeEndpointing.NO_SPEECH_TIMEOUT_MS)
  }

  @Test
  fun silenceBeforeSpeechIsNoSpeech() {
    val endpointing = HandsfreeEndpointing()
    endpointing.begin(0)
    assertFalse(endpointing.shouldFinishForSilence(900))
    assertFalse(endpointing.hasHeardSpeech())
    assertEquals(HandsfreeEndpointing.Silence.NO_SPEECH, endpointing.classifySilence())
  }

  @Test
  fun completeSilenceAfterVoiceFinishesTheTurn() {
    val endpointing = HandsfreeEndpointing()
    endpointing.begin(0)
    endpointing.onVoice(1_000)
    assertFalse(endpointing.shouldFinishForSilence(1_500))
    assertTrue(endpointing.shouldFinishForSilence(1_900))
    assertEquals(HandsfreeEndpointing.Silence.FINAL, endpointing.classifySilence())
  }

  @Test
  fun utteranceCeilingIsMeasuredFromTheTurnStart() {
    val endpointing = HandsfreeEndpointing()
    endpointing.begin(0)
    endpointing.onVoice(1_000)
    assertFalse(endpointing.isPastCeiling(59_999))
    assertTrue(endpointing.isPastCeiling(60_000))
  }

  @Test
  fun resetForgetsTheTurn() {
    val endpointing = HandsfreeEndpointing()
    endpointing.begin(0)
    endpointing.onVoice(500)
    endpointing.reset()
    assertFalse(endpointing.hasHeardSpeech())
    assertFalse(endpointing.isPastCeiling(100_000))
  }
}
