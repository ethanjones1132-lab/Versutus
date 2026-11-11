package com.versutus.handsfreevoice

import org.junit.Assert.assertEquals
import org.junit.Test

class StreamingPlaybackTest {
  @Test fun cancellationStopsAfterAtMostOneHundredMillisecondsOfPcm() {
    var running = true
    val writes = mutableListOf<Int>()
    PlaybackLoop(
      isRunning = { running },
      drain = { PlaybackChunk(1, ByteArray(24_000)) },
      write = { chunk -> writes += chunk.pcm.size; running = false },
    ).run()
    assertEquals(listOf(4_800), writes)
  }

  @Test fun aDequeuedChunkIsNotWrittenAfterItsGenerationIsCancelled() {
    val buffer = JitterBuffer(sampleRateHz = 24000, targetMs = 20)
    buffer.push(1, ByteArray(20 * 48) { 7 })
    val dequeuedBeforeCancel = buffer.drain()!!
    buffer.cancel(1)

    var writes = 0
    var drained = false
    PlaybackLoop(
      isRunning = { !drained },
      drain = { if (!drained) dequeuedBeforeCancel.also { drained = true } else null },
      write = { chunk ->
        synchronized(buffer) {
          if (buffer.isCurrent(chunk.gen)) writes += 1
        }
      },
    ).run()

    assertEquals("cancelled PCM must not reach AudioTrack", 0, writes)
  }
}
