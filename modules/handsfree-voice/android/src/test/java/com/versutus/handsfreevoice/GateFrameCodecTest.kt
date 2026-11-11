package com.versutus.handsfreevoice

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The Kotlin mirror of `gate/core/voice/protocol.mjs`, pinned against the same
 * shared fixture so a frame added on one side without the other fails a test
 * rather than a call.
 */
class GateFrameCodecTest {
  private fun fixture(): JSONObject {
    var dir: File? = File(System.getProperty("user.dir") ?: ".")
    while (dir != null) {
      val candidate = File(dir, "gate/__tests__/fixtures/voice-protocol.json")
      if (candidate.isFile) return JSONObject(candidate.readText())
      dir = dir.parentFile
    }
    error("voice-protocol.json not found from ${System.getProperty("user.dir")}")
  }

  @Test fun everyGateFrameInTheSharedFixtureParses() {
    val frames = fixture().getJSONArray("gateToPhone")
    for (i in 0 until frames.length()) {
      val expected = frames.getJSONObject(i)
      val parsed = GateFrameCodec.parse(expected.toString())
      assertEquals(expected.getString("t"), parsed.t)
    }
  }

  @Test fun everyPhoneFrameInTheSharedFixtureParses() {
    val frames = fixture().getJSONArray("phoneToGate")
    for (i in 0 until frames.length()) {
      val expected = frames.getJSONObject(i)
      val parsed = GateFrameCodec.parsePhone(expected.toString())
      assertEquals(expected.getString("t"), parsed.t)
    }
  }

  @Test fun v2FixtureFramesValidateTheirCallEnvelope() {
    val source = fixture()
    val gateFrames = source.getJSONArray("v2GateToPhone")
    for (i in 0 until gateFrames.length()) {
      val frame = gateFrames.getJSONObject(i)
      val parsed = GateFrameCodec.parse(frame.toString(), "vs-1")
      assertEquals(2, parsed.protocolVersion)
    }
    val phoneFrames = source.getJSONArray("v2PhoneToGate")
    for (i in 0 until phoneFrames.length()) {
      val frame = phoneFrames.getJSONObject(i)
      GateFrameCodec.parsePhone(frame.toString(), "vs-1")
    }
    assertThrows(GateProtocolError::class.java) {
      GateFrameCodec.parse(gateFrames.getJSONObject(0).toString(), "another-call")
    }
  }

  @Test fun everyDeclaredFrameTypeAppearsInTheSharedFixture() {
    val source = fixture()
    val gateSeen = mutableSetOf<String>()
    for (key in listOf("gateToPhone", "v2GateToPhone")) {
      val frames = source.getJSONArray(key)
      for (i in 0 until frames.length()) gateSeen.add(frames.getJSONObject(i).getString("t"))
    }
    assertEquals(GateFrameCodec.GATE_TYPES, gateSeen)

    val phoneSeen = mutableSetOf<String>()
    for (key in listOf("phoneToGate", "v2PhoneToGate")) {
      val frames = source.getJSONArray(key)
      for (i in 0 until frames.length()) phoneSeen.add(frames.getJSONObject(i).getString("t"))
    }
    assertEquals(GateFrameCodec.PHONE_TYPES, phoneSeen)
  }

  @Test fun aToolFrameCarriesOnlyItsBoundedLifecycleSummary() {
    val tool = GateFrameCodec.parse(
      """{"v":2,"callId":"vs-1","seq":12,"ts":11,"t":"tool","turnId":"t1","toolId":"call-1","name":"read","status":"running","summary":"read running"}""",
      "vs-1",
    )
    assertEquals(GateFrame.Tool("t1", "call-1", "read", "running", "read running"), tool)
    assertThrows(GateProtocolError::class.java) {
      GateFrameCodec.parse(
        """{"t":"tool","turnId":"t1","toolId":"call-1","name":"read","status":"done","summary":"read done"}""",
      )
    }
  }

  @Test fun approvalKeepsItsAdditiveIdentityAndState() {
    assertEquals(
      GateFrame.Approval("t1", "Run it?", "a1", "pending"),
      GateFrameCodec.parse(
        """{"t":"approval","turnId":"t1","summary":"Run it?","approvalId":"a1","state":"pending"}""",
      ),
    )
    assertEquals(
      GateFrame.Approval("t1", "Run it?", null, null),
      GateFrameCodec.parse("""{"t":"approval","turnId":"t1","summary":"Run it?"}"""),
    )
    assertThrows(GateProtocolError::class.java) {
      GateFrameCodec.parse("""{"t":"approval","turnId":"t1","summary":"Run it?","state":"maybe"}""")
    }
  }

  @Test fun everyMalformedFrameIsRejected() {
    val frames = fixture().getJSONArray("malformed")
    for (i in 0 until frames.length()) {
      val raw = frames.getJSONObject(i).toString()
      assertThrows(GateProtocolError::class.java) { GateFrameCodec.parse(raw) }
    }
  }

  @Test fun aFrameOverTheSizeCapIsRefused() {
    val huge = """{"t":"partial","text":"${"x".repeat(5000)}"}"""
    assertThrows(GateProtocolError::class.java) { GateFrameCodec.parse(huge) }
  }

  @Test fun parsedFramesCarryTheirFields() {
    val reply = GateFrameCodec.parse("""{"t":"reply","turnId":"t1","delta":"Hi"}""")
    assertEquals(GateFrame.Reply("t1", "Hi"), reply)

    val error = GateFrameCodec.parse("""{"t":"error","code":"backend_error","message":"boom","fatal":true}""")
    assertTrue(error is GateFrame.Error && error.fatal)
  }

  @Test fun aReadyFrameCarriesTheResumeWindow() {
    val ready = GateFrameCodec.parse("""{"t":"ready","engine":"local","resumeWindowMs":90000}""")
    assertEquals(GateFrame.Ready("local", 90_000L), ready)
    // A Gate that does not advertise one parses with no window, and a window
    // that is not a number is refused rather than guessed.
    assertEquals(GateFrame.Ready("local", null), GateFrameCodec.parse("""{"t":"ready","engine":"local"}"""))
    assertThrows(GateProtocolError::class.java) {
      GateFrameCodec.parse("""{"t":"ready","engine":"local","resumeWindowMs":"soon"}""")
    }
  }

  @Test fun aPhoneControlFrameEncodesAsTheGateExpects() {
    val mute = JSONObject(GateFrameCodec.encodePhone(GateFrame.Phone.Mute(true)))
    assertEquals("mute", mute.getString("t"))
    assertEquals(true, mute.getBoolean("on"))

    val skip = JSONObject(GateFrameCodec.encodePhone(GateFrame.Phone.Skip))
    assertEquals("skip", skip.getString("t"))
  }

  @Test fun resumeCursorIsParsedAndEncodedAsAControl() {
    val resume = GateFrameCodec.parsePhone(
      """{"v":2,"callId":"vs-1","seq":6,"ts":10,"t":"resume","lastSeq":8}""",
      "vs-1",
    )
    assertEquals(GateFrame.Phone.Resume(8), resume)
    assertEquals(8L, JSONObject(GateFrameCodec.encodePhone(resume as GateFrame.Phone.Resume)).getLong("lastSeq"))
    assertThrows(GateProtocolError::class.java) {
      GateFrameCodec.parsePhone("""{"t":"resume","lastSeq":-1}""")
    }
  }

  @Test fun playedFrameCarriesGenerationAndPhoneTimestamp() {
    val encoded = JSONObject(GateFrameCodec.encodePhone(GateFrame.Phone.Played(7, 1234)))
    assertEquals("played", encoded.getString("t"))
    assertEquals(7L, encoded.getLong("gen"))
    assertEquals(1234L, encoded.getLong("atMs"))
    assertEquals(GateFrame.Phone.Played(7, 1234), GateFrameCodec.parsePhone(encoded.toString()))
  }

  @Test fun playedDurationUsesElapsedTimeAndNeverGoesNegative() {
    assertEquals(75L, elapsedSincePcmReceived(8_000L, 8_075L))
    assertEquals(0L, elapsedSincePcmReceived(8_075L, 8_000L))
  }

  @Test fun v2PcmChunkCarriesGenerationAndSpeechStartSequence() {
    val bytes = java.nio.ByteBuffer.allocate(10)
      .order(java.nio.ByteOrder.BIG_ENDIAN)
      .putInt(7)
      .putInt(42)
      .put(byteArrayOf(1, 2))
      .array()
    val chunk = parseGatePcmChunk(bytes)!!
    assertEquals(7L, chunk.gen)
    assertEquals(42L, chunk.startSeq)
    assertEquals(listOf<Byte>(1, 2), chunk.pcm.toList())
    assertEquals(null, parseGatePcmChunk(byteArrayOf(1, 2)))
  }
}
