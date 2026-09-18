package com.versutus.handsfreevoice

/**
 * A value safe to put in an HTTP header: printable ASCII only, trimmed.
 * OkHttp throws on any control character, so a gateway token stored with a
 * trailing `\r` refused every call start. Mirrors `sanitizeHeaderValue` in
 * `src/lib/gateway/http-transport.ts`.
 */
internal fun cleanHeaderValue(value: String): String =
  value.filter { it.code in 0x20..0x7E }.trim()
