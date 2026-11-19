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

  @Test fun pendingAndExpiredApprovalAudioUseTheOpenReplyGeneration() {
    val buffer = JitterBuffer(sampleRateHz = 24000, targetMs = 20)
    val writes = mutableListOf<Pair<Long, Byte>>()
    val start = GateFrameCodec.parse("""{"t":"speech","gen":7,"state":"start"}""") as GateFrame.Speech
    buffer.start(start.gen)

    // Like HandsfreeGateMedia, approval frames are UI-only; the Gate supplies
    // the pending and expiry announcements as normal reply PCM, not phone TTS.
    listOf("pending", "expired").forEachIndexed { index, state ->
      val card = GateFrameCodec.parse(
        """{"t":"approval","turnId":"t1","approvalId":"a1","summary":"edit draft","state":"$state"}""",
      ) as GateFrame.Approval
      assertEquals(state, card.state)
      val payload = java.nio.ByteBuffer.allocate(8 + 20 * 48)
        .putInt(7).putInt(42).put(ByteArray(20 * 48) { (index + 1).toByte() }).array()
      val pcm = parseGatePcmChunk(payload)!!
      assertEquals(42L, pcm.startSeq)
      buffer.push(pcm.gen, pcm.pcm)
    }
    var running = true
    PlaybackLoop(
      isRunning = { running },
      drain = buffer::drain,
      write = { chunk -> if (buffer.isCurrent(chunk.gen)) writes += chunk.gen to chunk.pcm[0] },
      sleepMs = { running = false },
    ).run()
    assertEquals(listOf(7L to 1.toByte(), 7L to 2.toByte()), writes)
  }
}
