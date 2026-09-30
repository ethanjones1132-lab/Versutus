package com.versutus.handsfreevoice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.random.Random

/**
 * The socket's reader thread, the playback thread and the caller's thread all
 * touch one buffer. A race here threw `NoSuchElementException` on a background
 * thread, which kills the process, so the hammer collects every throwable and
 * fails on any of them.
 */
class JitterBufferConcurrencyTest {
  /** 24 kHz mono PCM16 is 48 bytes per millisecond. */
  private fun frame(ms: Int) = ByteArray(ms * 48)

  @Test fun pushCancelDrainAndFlushFromEveryThreadNeverThrow() {
    val buffer = JitterBuffer(sampleRateHz = 24000, targetMs = 60, maxPendingMs = 100)
    val failures = CopyOnWriteArrayList<Throwable>()
    val deadlineNs = System.nanoTime() + 500_000_000L

    val bodies = listOf<(Random) -> Unit>(
      { random -> buffer.push(gen = random.nextLong(1, 4), pcm = frame(20)) },
      { random -> buffer.cancel(random.nextLong(1, 4)) },
      { buffer.drain() },
      {
        buffer.drain()
        if (buffer.pendingMs() < 0) failures.add(IllegalStateException("pendingMs went negative"))
      },
      { buffer.flush() },
    )

    val workers = bodies.mapIndexed { index, body ->
      Thread {
        val random = Random(index * 31 + 7)
        try {
          while (System.nanoTime() < deadlineNs) body(random)
        } catch (t: Throwable) {
          failures.add(t)
        }
      }.also {
        it.name = "jitter-hammer-$index"
        it.isDaemon = true
      }
    }
    workers.forEach { it.start() }
    workers.forEach { it.join(10_000) }

    assertTrue("the racing threads threw: $failures", failures.isEmpty())
    assertEquals("a worker outlived the deadline", emptyList<Thread>(), workers.filter { it.isAlive })
    assertTrue(buffer.pendingMs() >= 0)
  }

  /** The rules themselves still hold once the hammering stops. */
  @Test fun theQueueIsStillUsableAfterwards() {
    val buffer = JitterBuffer(sampleRateHz = 24000, targetMs = 60)
    repeat(200) {
      buffer.push(gen = 1, pcm = frame(20))
      buffer.drain()
      buffer.cancel(gen = 1)
      buffer.flush()
    }
    assertEquals(0, buffer.pendingMs())
    assertEquals(null, buffer.drain())
  }
}
