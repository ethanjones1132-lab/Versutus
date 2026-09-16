package com.versutus.widget

/** The `versutus://` links the widget rows build, kept pure so a JVM test can read them. */
object WidgetLinks {
  /** The chat deep link the existing router already answers (`deep-link.ts:75-78`). */
  fun botChatUri(botId: String): String = "versutus://chat?bot=" + percentEncode(botId)

  /** The scheduled-work surface the routine-tally line opens, through the same router. */
  const val ACTIVITY_URI: String = "versutus://activity"

  /** RFC 3986 unreserved characters kept as-is; everything else is UTF-8 percent-encoded. */
  private fun percentEncode(value: String): String {
    val out = StringBuilder()
    for (byte in value.toByteArray(Charsets.UTF_8)) {
      val c = byte.toInt().toChar()
      if (c.code < 128 && (c.isLetterOrDigit() || c in "-._~")) out.append(c)
      else out.append('%').append("%02X".format(byte.toInt() and 0xFF))
    }
    return out.toString()
  }
}
