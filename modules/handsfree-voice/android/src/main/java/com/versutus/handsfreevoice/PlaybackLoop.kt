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
  private val drain: () -> ByteArray?,
  private val write: (ByteArray) -> Unit,
  private val sleepMs: (Long) -> Unit = { Thread.sleep(it) },
  private val maxWriteBytes: Int = 4_800,
) {
  fun run() {
    try {
      while (isRunning()) {
        val pcm = drain()
        if (pcm == null) {
          sleepMs(IDLE_SLEEP_MS)
          continue
        }
        // A write can block while AudioTrack consumes it. Bound each call to
        // 100 ms of 24 kHz mono PCM so pause/flush can cut it short.
        var offset = 0
        while (offset < pcm.size && isRunning()) {
          val end = minOf(offset + maxWriteBytes, pcm.size) and -2
          if (end <= offset) break
          write(if (offset == 0 && end == pcm.size) pcm else pcm.copyOfRange(offset, end))
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
