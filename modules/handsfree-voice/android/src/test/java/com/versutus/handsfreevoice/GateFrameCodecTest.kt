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

  @Test fun aPhoneControlFrameEncodesAsTheGateExpects() {
    val mute = JSONObject(GateFrameCodec.encodePhone(GateFrame.Phone.Mute(true)))
    assertEquals("mute", mute.getString("t"))
    assertEquals(true, mute.getBoolean("on"))

    val skip = JSONObject(GateFrameCodec.encodePhone(GateFrame.Phone.Skip))
    assertEquals("skip", skip.getString("t"))
  }
}
