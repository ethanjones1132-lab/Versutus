package com.versutus.handsfreevoice

private const val HEX_DIGITS = "0123456789abcdef"

/**
 * JSON string escaping for the frames the phone hand-builds.
 *
 * OkHttp reports a DNS failure as `Unable to resolve host "host": No address
 * associated with hostname`, so an interpolated message carries quotes and
 * sometimes newlines. The JS side only treats a socket failure as retryable if
 * `parseGateFrame` accepts the frame, and a broken frame ends the call instead
 * of using the Gate's resume window -- so a hand-built frame is escaped here
 * rather than interpolated raw.
 */
internal fun escapeJsonString(s: String): String {
  val out = StringBuilder(s.length + 16)
  for (c in s) {
    when (c) {
      '"' -> out.append("\\\"")
      '\\' -> out.append("\\\\")
      '\n' -> out.append("\\n")
      '\r' -> out.append("\\r")
      '\t' -> out.append("\\t")
      // Everything else below 0x20 (NUL, backspace, form feed) has no short form.
      else -> if (c < ' ') out.appendUnicodeEscape(c) else out.append(c)
    }
  }
  return out.toString()
}

private fun StringBuilder.appendUnicodeEscape(c: Char) {
  // Control characters are 0x00..0x1f, so two hex digits always suffice.
  append("\\u00")
  append(HEX_DIGITS[(c.code shr 4) and 0xF])
  append(HEX_DIGITS[c.code and 0xF])
}
