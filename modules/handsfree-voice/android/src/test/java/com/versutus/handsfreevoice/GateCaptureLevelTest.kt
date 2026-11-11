package com.versutus.handsfreevoice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A Gate call has no phone recognizer or VAD tap, so the banner's listening dot
 * had no sample at all. These prove the measurement the capture loop now takes
 * from the frames it actually sent.
 */
class GateCaptureLevelTest {
  @Test fun aSilentFrameReadsAsNothing() {
    assertEquals(0.0, GateCaptureLevel.rmsLevel(ByteArray(320), 320), 1e-9)
  }

  @Test fun aHalfScaleSquareWaveReadsAsAHalf() {
    val frame = pcm16(shortArrayOf(16384, -16384, 16384, -16384))

    assertEquals(0.5, GateCaptureLevel.rmsLevel(frame, frame.size), 1e-6)
  }

  @Test fun aFullScaleFrameReadsAsFull() {
    val frame = pcm16(shortArrayOf(32767, -32768))

    assertEquals(1.0, GateCaptureLevel.rmsLevel(frame, frame.size), 1e-4)
  }

  @Test fun onlyTheBytesTheReadFilledAreMeasured() {
    // The capture buffer is reused; a short read must not measure the tail the
    // previous frame left in it.
    val frame = pcm16(shortArrayOf(16384, 16384)) + pcm16(shortArrayOf(32767, 32767))

    assertEquals(0.5, GateCaptureLevel.rmsLevel(frame, 4), 1e-6)
  }

  @Test fun aTrailingOddByteIsNotASample() {
    val frame = pcm16(shortArrayOf(16384, 16384)) + byteArrayOf(0x7F)

    assertEquals(0.5, GateCaptureLevel.rmsLevel(frame, frame.size), 1e-6)
  }

  @Test fun anEmptyReadReportsNothing() {
    val emitted = mutableListOf<Double>()
    val tap = GateCaptureLevelTap(emit = { emitted.add(it) }, nowMs = { 1_000L })

    tap.accept(ByteArray(320), 0)

    assertTrue(emitted.isEmpty())
  }

  @Test fun aLevelIsReportedAtMostTenTimesASecond() {
    val emitted = mutableListOf<Double>()
    var now = 1_000L
    val tap = GateCaptureLevelTap(emit = { emitted.add(it) }, nowMs = { now })
    val frame = pcm16(shortArrayOf(16384, 16384))

    // The first frame of a call is reported at once: the dot must move before
    // the first interval has elapsed.
    tap.accept(frame, frame.size)
    repeat(4) {
      now += 20
      tap.accept(frame, frame.size)
    }
    assertEquals(1, emitted.size)

    now += 100
    tap.accept(frame, frame.size)
    assertEquals(2, emitted.size)
    assertEquals(0.5, emitted.last(), 1e-6)
  }

  @Test fun aNewCallReportsItsFirstFrameAtOnce() {
    val emitted = mutableListOf<Double>()
    var now = 1_000L
    val tap = GateCaptureLevelTap(emit = { emitted.add(it) }, nowMs = { now })
    val frame = pcm16(shortArrayOf(16384, 16384))

    tap.accept(frame, frame.size)
    now += 20
    tap.accept(frame, frame.size)
    assertEquals(1, emitted.size)

    tap.reset()
    tap.accept(frame, frame.size)
    assertEquals(2, emitted.size)
  }

  private fun pcm16(samples: ShortArray): ByteArray {
    val bytes = ByteArray(samples.size * 2)
    samples.forEachIndexed { index, sample ->
      val value = sample.toInt()
      bytes[index * 2] = (value and 0xFF).toByte()
      bytes[index * 2 + 1] = ((value shr 8) and 0xFF).toByte()
    }
    return bytes
  }
}
