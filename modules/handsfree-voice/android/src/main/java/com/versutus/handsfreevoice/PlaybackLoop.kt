package com.versutus.handsfreevoice

/**
 * The playback thread's loop, without the Android types, so the shutdown races
 * can be tested on the JVM.
 *
 * The loop never propagates anything: a hang-up interrupts the thread while it
 * sleeps on an empty buffer, and an uncaught `InterruptedException` (or any
 * other throwable from a dead AudioTrack) on a non-main thread reaches Android's
 * default handler and kills the app. Correctness rests on [isRunning] flipping
 * to false; the interrupt is only a wake-up, so the flag is restored and the
 * loop simply ends.
 */
class PlaybackLoop(
  private val isRunning: () -> Boolean,
  private val drain: () -> PlaybackChunk?,
  private val write: (PlaybackChunk) -> Unit,
  private val sleepMs: (Long) -> Unit = { Thread.sleep(it) },
  private val maxWriteBytes: Int = 4_800,
) {
  fun run() {
    try {
      while (isRunning()) {
        val chunk = drain()
        if (chunk == null) {
          sleepMs(IDLE_SLEEP_MS)
          continue
        }
        // A write can block while AudioTrack consumes it. Bound each call to
        // 100 ms of 24 kHz mono PCM so pause/flush can cut it short.
        var offset = 0
        // Once drain() hands us a buffer, write at least its first chunk. The
        // call can stop while drain() runs; dropping that buffer loses audio
        // that was already removed from the queue. Later chunks remain
        // interruptible between bounded writes.
        while (offset < chunk.pcm.size && (offset == 0 || isRunning())) {
          val end = minOf(offset + maxWriteBytes, chunk.pcm.size) and -2
          if (end <= offset) break
          write(chunk.copy(pcm = if (offset == 0 && end == chunk.pcm.size) chunk.pcm else chunk.pcm.copyOfRange(offset, end)))
          offset = end
        }
      }
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    } catch (_: Throwable) {
      // A dead AudioTrack ends this call's playback; it does not end the app.
    }
  }

  companion object {
    /** Short enough to keep the speaker fed, long enough not to spin the CPU. */
    private const val IDLE_SLEEP_MS = 5L
  }
}
