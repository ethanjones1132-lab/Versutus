package com.versutus.widget

import org.json.JSONObject

/** The v1 payload the JS side writes; see VersutusWidget.types.ts. */
data class WidgetPayload(
  val status: String,
  val connected: Boolean,
  val work: String,
  val result: String?,
  val approvalsPending: Int,
  val writtenAt: Long,
) {
  sealed interface Parsed {
    data class Ok(val payload: WidgetPayload) : Parsed
    data object NeedsUpdate : Parsed
    data object Invalid : Parsed
  }

  companion object {
    fun parse(json: String?): Parsed {
      if (json.isNullOrBlank()) return Parsed.Invalid
      return try {
        val o = JSONObject(json)
        when (o.optInt("v", -1)) {
          1 -> Unit
          -1 -> return Parsed.Invalid
          else -> return Parsed.NeedsUpdate
        }
        val status = o.optString("status", "")
        val work = o.optString("work", "")
        val approvals = o.optInt("approvalsPending", -1)
        val writtenAt = o.optLong("writtenAt", Long.MIN_VALUE)
        if (status.isBlank() || work.isBlank() || approvals < 0 || writtenAt <= 0 || !o.has("connected")) {
          return Parsed.Invalid
        }
        val result = o.optString("result", "").takeIf { it.isNotBlank() }
        Parsed.Ok(WidgetPayload(status, o.getBoolean("connected"), work, result, approvals, writtenAt))
      } catch (_: Exception) {
        Parsed.Invalid
      }
    }
  }
}
