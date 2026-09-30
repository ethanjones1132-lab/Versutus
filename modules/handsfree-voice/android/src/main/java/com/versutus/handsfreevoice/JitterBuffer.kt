package com.versutus.handsfreevoice

/**
 * Holds playable PCM until a small target depth is reached, so a network
 * hiccup does not gap the reply, and drops audio the Gate has cancelled. It is
 * deliberately free of Android types so the flush and latency rules can be
 * tested on the JVM.
 *
 * Binary frames arrive in order on the socket; this buffer does not resequence
 * them. Its job is depth and generation discipline: `speech/start` opens a
 * generation, a newer generation discards anything staler, and `cancelled`
 * empties the queue.
 *
 * The socket's reader thread pushes and cancels, the playback thread drains and
 * the caller's thread flushes, so every member is synchronized: without it a
 * barge-in `cancel()` landing between `drain()`'s emptiness check and its
 * `removeFirst()` throws on the playback thread, which kills the app.
 */
class JitterBuffer(
  sampleRateHz: Int = 24000,
  channels: Int = 1,
  bytesPerSample: Int = 2,
  private val targetMs: Int = 60,
  private val maxPendingMs: Int = 300,
) {
  private val queued = ArrayDeque<ByteArray>()
  private var totalBytes = 0
  private var activeGen = 0L
  private var primed = false

  private val bytesPerMs = (sampleRateHz * channels * bytesPerSample / 1000).coerceAtLeast(1)

  /** Queue a chunk belonging to [gen]. */
  @Synchronized
  fun push(gen: Long, pcm: ByteArray) {
    if (pcm.isEmpty()) return
    if (gen < activeGen) return
    if (gen > activeGen) {
      activeGen = gen
      clear()
    }
    queued.addLast(pcm)
    totalBytes += pcm.size
    trimToCap()
  }

  /** The Gate cancelled [gen]; anything still queued for it is stale. */
  @Synchronized
  fun cancel(gen: Long) {
    if (gen == activeGen) clear()
  }

  /**
   * The oldest chunk. Playback waits for [targetMs] of audio before it leaves
   * the gate the first time, then keeps draining until the queue empties
   * (which re-arms the wait for the next generation). The remove is
   * null-returning, so a queue emptied by a cancel or flush drains to nothing
   * rather than throwing on the playback thread.
   */
  @Synchronized
  fun drain(): ByteArray? {
    if (!primed) {
      if (pendingMs() < targetMs) return null
      primed = true
    }
    val pcm = queued.removeFirstOrNull()
    if (pcm == null) {
      primed = false
      return null
    }
    totalBytes -= pcm.size
    if (queued.isEmpty()) primed = false
    return pcm
  }

  @Synchronized
  fun pendingMs(): Int = totalBytes / bytesPerMs

  @Synchronized
  fun flush() = clear()

  @Synchronized
  private fun clear() {
    queued.clear()
    totalBytes = 0
    primed = false
  }

  @Synchronized
  private fun trimToCap() {
    while (queued.size > 1 && pendingMs() > maxPendingMs) {
      totalBytes -= queued.removeFirst().size
    }
  }
}
