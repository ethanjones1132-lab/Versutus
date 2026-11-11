package com.versutus.handsfreevoice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class JitterBufferTest {
  /** 24 kHz mono PCM16 is 48 bytes per millisecond. */
  private fun frame(ms: Int) = ByteArray(ms * 48)

  @Test fun nothingDrainsUntilTheTargetDepthIsReached() {
    val buffer = JitterBuffer(sampleRateHz = 24000, targetMs = 60)
    buffer.push(gen = 1, pcm = frame(20))
    assertNull(buffer.drain())
    buffer.push(gen = 1, pcm = frame(40))
    assertEquals(20, buffer.drain()!!.pcm.size / 48)
  }

  @Test fun chunksDrainInTheOrderTheyArrived() {
    val buffer = JitterBuffer(sampleRateHz = 24000, targetMs = 60)
    buffer.push(1, ByteArray(20 * 48) { 1 })
    buffer.push(1, ByteArray(20 * 48) { 2 })
    buffer.push(1, ByteArray(20 * 48) { 3 })
    assertEquals(1.toByte(), buffer.drain()!!.pcm.first())
    assertEquals(2.toByte(), buffer.drain()!!.pcm.first())
    assertEquals(3.toByte(), buffer.drain()!!.pcm.first())
  }

  @Test fun aNewerGenerationDropsTheOlderQueuedAudio() {
    val buffer = JitterBuffer(sampleRateHz = 24000, targetMs = 60)
    buffer.push(gen = 1, pcm = frame(40))
    // Generation 2 begins: everything from generation 1 is stale.
    buffer.push(gen = 2, pcm = frame(20))
    assertEquals(20, buffer.pendingMs())
    buffer.push(gen = 2, pcm = frame(40))
    assertEquals(60, buffer.pendingMs())
  }

  @Test fun aCancelledGenerationFlushesItsQueuedAudio() {
    val buffer = JitterBuffer(sampleRateHz = 24000, targetMs = 60)
    buffer.push(gen = 1, pcm = frame(40))
    buffer.cancel(gen = 1)
    assertEquals(0, buffer.pendingMs())
    assertNull(buffer.drain())
  }

  @Test fun audioArrivingLateForACancelledGenerationIsRejected() {
    val buffer = JitterBuffer(sampleRateHz = 24000, targetMs = 20)
    buffer.push(gen = 1, pcm = frame(20))
    buffer.cancel(gen = 1)
    buffer.push(gen = 1, pcm = frame(20))
    assertEquals(0, buffer.pendingMs())
    assertNull(buffer.drain())
  }

  @Test fun f8KeepsCurrentGenerationAudioAndRefusesNewestAtSafetyCap() {
    var warnings = 0
    val buffer = JitterBuffer(sampleRateHz = 24000, targetMs = 60, maxPendingMs = 100) { warnings += 1 }
    val chunks = (1..5).map { marker -> ByteArray(20 * 48) { marker.toByte() } }
    chunks.forEach { buffer.push(gen = 1, pcm = it) }
    buffer.push(gen = 1, pcm = frame(20)) // newest chunk is refused at 100 ms
    assertEquals(100, buffer.pendingMs())
    assertEquals(1, warnings)
    assertEquals("oldest current-gen audio is preserved", 1.toByte(), buffer.drain()!!.pcm.first())
    assertEquals(2.toByte(), buffer.drain()!!.pcm.first())
    assertEquals(3.toByte(), buffer.drain()!!.pcm.first())
    assertEquals(4.toByte(), buffer.drain()!!.pcm.first())
    assertEquals(5.toByte(), buffer.drain()!!.pcm.first())
    assertEquals("the capacity warning is emitted only once", 1, warnings)
  }

  @Test fun flushClearsEveryGeneration() {
    val buffer = JitterBuffer(sampleRateHz = 24000, targetMs = 60)
    buffer.push(1, frame(40))
    buffer.flush()
    assertEquals(0, buffer.pendingMs())
    assertNull(buffer.drain())
  }
}
