package com.versutus.handsfreevoice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GateCaptureStateTest {
  @Test fun captureWaitsForTheGateToConfirmTheProtocol() {
    val state = GateCaptureState()
    val mic = FakeMicSource()
    state.setRunning(true)
    state.setNegotiated(false)
    state.attachSource(mic)

    assertFalse(state.shouldRead())
    assertFalse(mic.started)
    assertEquals(0, state.readAndSend(mic, ByteArray(4)) {})

    state.setNegotiated(true)
    assertTrue(state.shouldRead())
    assertTrue(mic.started)
  }

  @Test fun muteStopsMicAndUnmuteRestartsItWithoutSendingMutedSamples() {
    val state = GateCaptureState()
    val mic = FakeMicSource()
    val sent = mutableListOf<ByteArray>()
    state.setRunning(true)
    state.attachSource(mic)

    assertEquals(1, state.readAndSend(mic, ByteArray(4)) { sent.add(it) })
    state.setMuted(true)
    assertFalse(mic.started)
    val readsBeforeMute = mic.reads
    assertEquals(0, state.readAndSend(mic, ByteArray(4)) { sent.add(it) })
    assertEquals(readsBeforeMute, mic.reads)
    state.setMuted(false)

    assertTrue(mic.started)
    state.readAndSend(mic, ByteArray(4)) { sent.add(it) }
    assertEquals(2, sent.size)
    assertEquals(1, mic.stops)
    assertEquals(2, mic.starts)
  }

  @Test fun aNewCaptureStartsUnmutedAndStoppedCaptureCannotRestartOnUnmute() {
    val fresh = GateCaptureState()
    assertTrue(fresh.shouldRead().not())
    fresh.setRunning(true)
    assertTrue(fresh.shouldRead())

    val mic = FakeMicSource()
    fresh.attachSource(mic)
    fresh.setMuted(true)
    fresh.setRunning(false)
    fresh.setMuted(false)
    assertFalse(mic.started)
    assertFalse(fresh.shouldRead())
  }

  @Test fun socketPressurePausesCaptureAtTwoSecondsAndRecoversWithoutStoppingTheCall() {
    val state = GateCaptureState()
    val mic = FakeMicSource()
    val changes = mutableListOf<Boolean>()
    val frameBytes = 640
    val limit = 64_000
    val pressure = GateCapturePressure(limit, frameBytes) { paused ->
      changes.add(paused)
      state.setPaused(paused)
    }
    state.setRunning(true)
    state.attachSource(mic)
    var queued = 0L
    repeat(1_000) {
      if (!pressure.shouldPause(queued)) {
        state.readAndSend(mic, ByteArray(frameBytes)) { queued += frameBytes }
      }
      assertTrue(queued <= limit)
    }
    assertEquals(limit.toLong(), queued)
    assertEquals(listOf(true), changes)
    assertFalse(mic.started)
    assertEquals(100, mic.reads)
    assertTrue(pressure.shouldPause(32_001))

    assertFalse(pressure.shouldPause(32_000))
    assertTrue(mic.started)
    assertEquals(1, state.readAndSend(mic, ByteArray(frameBytes)) {})
    assertEquals(listOf(true, false), changes)
  }

  @Test fun drainingTheQueueDoesNotOpenAMutedMicrophone() {
    val state = GateCaptureState()
    val mic = FakeMicSource()
    state.setRunning(true)
    state.attachSource(mic)
    val pressure = GateCapturePressure(64_000, 640, state::setPaused)
    assertTrue(pressure.shouldPause(64_000))
    state.setMuted(true)
    assertFalse(pressure.shouldPause(0))
    assertFalse(mic.started)
    assertFalse(state.shouldSend())
  }

  @Test fun audioBufferedAroundAMuteIsNeverSentAfterUnmute() {
    val state = GateCaptureState()
    val mic = FakeMicSource()
    val sent = mutableListOf<Byte>()
    state.setRunning(true)
    state.attachSource(mic)
    state.readAndSend(mic, ByteArray(4)) { sent.add(it[0]) }

    // Worst case for privacy: the recorder captured speech that was still in
    // its buffer when mute stopped it, and stop()/start() do not clear it.
    mic.pending.addLast(MUTED_SPEECH)
    state.setMuted(true)
    mic.pending.addLast(MUTED_SPEECH)
    state.setMuted(false)
    repeat(3) { state.readAndSend(mic, ByteArray(4)) { sent.add(it[0]) } }

    assertFalse("muted speech must never be sent", sent.contains(MUTED_SPEECH))
    assertEquals(4, sent.size)
  }

  @Test fun aMuteLandsWhileTheCaptureThreadIsParkedInABlockingRead() {
    // The production capture loop spends nearly all its time inside a blocking
    // AudioRecord read. Holding the capture state's monitor across it put a
    // Mute tap behind that read on the caller's thread — the same thread the
    // banner is drawn from. The mute flag is volatile and written without it.
    val state = GateCaptureState()
    val entered = java.util.concurrent.CountDownLatch(1)
    val release = java.util.concurrent.CountDownLatch(1)
    val mic = object : MicSource {
      var started = false
      override fun start() { started = true }
      override fun stop() { started = false }
      override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        entered.countDown()
        release.await(5, java.util.concurrent.TimeUnit.SECONDS)
        return if (started) 1 else 0
      }
      override fun drain() {}
      override fun release() { started = false }
    }
    state.setRunning(true)
    state.attachSource(mic)
    val capture = Thread { state.readAndSend(mic, ByteArray(4)) {} }
    capture.start()
    assertTrue("the capture thread never reached its read", entered.await(5, java.util.concurrent.TimeUnit.SECONDS))

    val applied = java.util.concurrent.CountDownLatch(1)
    val tap = Thread { state.setMuted(true); applied.countDown() }
    tap.start()
    assertTrue("a Mute tap waited on the blocking read", applied.await(1, java.util.concurrent.TimeUnit.SECONDS))
    assertFalse(state.shouldRead())

    release.countDown()
    capture.join(5_000)
    tap.join(5_000)
  }

  private class FakeMicSource : MicSource {
    var started = false
    var starts = 0
    var stops = 0
    var reads = 0
    /** Samples sitting in the recorder's buffer; stop() and start() keep them. */
    val pending = ArrayDeque<Byte>()
    override fun start() { started = true; starts += 1 }
    override fun stop() { if (started) stops += 1; started = false }
    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
      check(started)
      reads += 1
      buffer[offset] = pending.removeFirstOrNull() ?: reads.toByte()
      return 1
    }
    override fun drain() { pending.clear() }
    override fun release() { started = false }
  }

  private companion object {
    const val MUTED_SPEECH: Byte = 0x7F
  }
}
