package com.versutus.handsfreevoice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class JsonEscapeTest {
  @Test fun `quotes and backslashes are escaped`() {
    assertEquals("""he said \"stop\"""", escapeJsonString("""he said "stop""""))
    assertEquals("""C:\\Users\\ada""", escapeJsonString("""C:\Users\ada"""))
  }

  @Test fun `the escapes with a short form are used`() {
    assertEquals("""line\nnext""", escapeJsonString("line\nnext"))
    assertEquals("""carriage\rreturn""", escapeJsonString("carriage\rreturn"))
    assertEquals("""tab\there""", escapeJsonString("tab\there"))
  }

  @Test fun `the remaining control characters become unicode escapes`() {
    assertEquals("""\u0000""", escapeJsonString("\u0000"))
    // Kotlin's \b is a backspace, and JSON has no short form for it or for the
    // form feed, so both take the four-digit escape.
    assertEquals("""\u0008""", escapeJsonString("\b"))
    assertEquals("""\u000c""", escapeJsonString('\u000C'.toString()))
    assertEquals("""\u001f""", escapeJsonString("\u001f"))
  }

  @Test fun `everything else passes through`() {
    val message = "naïve ✓ 🎤 100% — socket"
    assertEquals(message, escapeJsonString(message))
    assertEquals("", escapeJsonString(""))
  }

  /**
   * The frame JS actually receives on a DNS failure: OkHttp's message carries
   * quotes, and a broken frame makes `isRetryableSocketFailure` return false, so
   * the call ends instead of re-attaching inside the Gate's resume window.
   */
  @Test fun `an okHttp failure message survives as a whole frame`() {
    val message = """Unable to resolve host "gate.local": No address associated with hostname
    at 10.0.0.4:8080"""
    val frame =
      """{"t":"error","code":"socket_failed","message":"${escapeJsonString(message)}","fatal":true}"""

    val escaped = escapeJsonString(message)
    for (i in escaped.indices) {
      if (escaped[i] == '"') assertTrue("a bare quote survived at $i", i > 0 && escaped[i - 1] == '\\')
    }
    assertTrue("no raw control character may survive", escaped.none { it < ' ' })
    // Structural check: the message is the only free value, so what surrounds
    // it is exactly the frame the codec expects.
    assertEquals(
      listOf("{\"t\":\"error\",\"code\":\"socket_failed\",\"message\":\"", "\",\"fatal\":true}"),
      frame.split(escaped),
    )
    assertEquals(message, unescape(escaped))
  }

  /** The inverse of [escapeJsonString], so the escape set is pinned exactly. */
  private fun unescape(escaped: String): String {
    val out = StringBuilder()
    var i = 0
    while (i < escaped.length) {
      if (escaped[i] != '\\') {
        out.append(escaped[i])
        i += 1
        continue
      }
      check(i + 1 < escaped.length) { "a trailing backslash is never valid JSON" }
      when (val escape = escaped[i + 1]) {
        '"' -> out.append('"')
        '\\' -> out.append('\\')
        'n' -> out.append('\n')
        'r' -> out.append('\r')
        't' -> out.append('\t')
        'u' -> {
          out.append(escaped.substring(i + 2, i + 6).toInt(16).toChar())
          i += 6
          continue
        }
        else -> throw IllegalStateException("unknown escape: \\$escape")
      }
      i += 2
    }
    return out.toString()
  }
}
