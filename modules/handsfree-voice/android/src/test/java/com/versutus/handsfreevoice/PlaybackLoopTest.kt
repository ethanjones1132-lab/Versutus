package com.versutus.handsfreevoice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackLoopTest {
  /**
   * The hang-up path: `stop()` flips `running` and interrupts the thread while
   * it sleeps on an empty buffer. An uncaught `InterruptedException` here took
   * the whole app down.
   */
  @Test fun anInterruptedSleepEndsTheLoopAndRestoresTheInterruptFlag() {
    Thread.interrupted()
    try {
      PlaybackLoop(
        isRunning = { true },
        drain = { null },
        write = { throw AssertionError("an empty buffer must not be written") },
        sleepMs = { throw InterruptedException("call ended") },
      ).run()
      assertTrue("the interrupt flag was swallowed", Thread.interrupted())
    } finally {
      Thread.interrupted()
    }
  }

  @Test fun aFailingWriteEndsTheLoopWithoutPropagating() {
    var writes = 0
    PlaybackLoop(
      isRunning = { true },
      drain = { ByteArray(48) },
      write = {
        writes += 1
        throw IllegalStateException("the AudioTrack is gone")
      },
    ).run()
    assertEquals(1, writes)
  }

  @Test fun theLoopEndsWhenTheCallIsNoLongerRunning() {
    var writes = 0
    PlaybackLoop(
      isRunning = { writes < 3 },
      drain = { ByteArray(48) },
      write = { writes += 1 },
      sleepMs = { throw AssertionError("queued audio must be written, not slept on") },
    ).run()
    assertEquals(3, writes)
  }

  @Test fun drainedAudioIsHandedToTheTrack() {
    val written = mutableListOf<ByteArray>()
    var drained = 0
    PlaybackLoop(
      isRunning = { drained < 2 },
      drain = {
        drained += 1
        ByteArray(4) { 9 }
      },
      write = { written.add(it) },
      sleepMs = { throw AssertionError("queued audio must be written, not slept on") },
    ).run()
    assertEquals(2, written.size)
    assertEquals(listOf(9.toByte(), 9.toByte()), written.map { it.first() })
  }

  @Test fun anEmptyBufferSleepsRatherThanSpinning() {
    var sleeps = 0
    PlaybackLoop(
      isRunning = { sleeps == 0 },
      drain = { null },
      write = { throw AssertionError("an empty buffer must not be written") },
      sleepMs = { sleeps += 1 },
    ).run()
    assertEquals(1, sleeps)
  }
}
