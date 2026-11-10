package com.versutus.handsfreevoice

import org.junit.Assert.assertEquals
import org.junit.Test

class StreamingPlaybackTest {
  @Test fun cancellationStopsAfterAtMostOneHundredMillisecondsOfPcm() {
    var running = true
    val writes = mutableListOf<Int>()
    PlaybackLoop(
      isRunning = { running },
      drain = { ByteArray(24_000) },
      write = { pcm -> writes += pcm.size; running = false },
    ).run()
    assertEquals(listOf(4_800), writes)
  }
}
