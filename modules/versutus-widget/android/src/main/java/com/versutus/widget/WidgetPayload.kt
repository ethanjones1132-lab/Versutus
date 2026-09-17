package com.versutus.widget

import org.json.JSONArray
import org.json.JSONObject

/** A named in-flight run, for the large cell's list. */
data class WidgetRun(val title: String, val state: String)

/** One quick-launch Bot: the id to open, and the name to draw. */
data class WidgetBot(val id: String, val label: String)

/** The v1, v2 and v3 payloads the JS side writes; see VersutusWidget.types.ts. */
data class WidgetPayload(
  val status: String,
  val connected: Boolean,
  val work: String,
  val result: String?,
  val approvalsPending: Int,
  val writtenAt: Long,
  val runs: List<WidgetRun> = emptyList(),
  val bots: List<WidgetBot> = emptyList(),
  /** Version 3: the routine warn tallies. Zero on both counts means silent. */
  val routinesFailing: Int = 0,
  val routinesLate: Int = 0,
  val redact: Boolean = false,
  val configBots: List<WidgetBot> = bots,
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
        val version = o.optInt("v", -1)
        when (version) {
          1, 2, 3 -> Unit
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
        val runs = if (version >= 2) parseRuns(o.optJSONArray("runs")) else emptyList()
        val bots = if (version >= 2) parseBots(o.optJSONArray("bots")) else emptyList()
        // A count the app never wrote reads as silent rather than negative:
        // the JS side clamps before it writes, so only hand-mangled state
        // gets here, and a negative tally would word itself as a debt.
        val routinesFailing = if (version >= 3) o.optInt("routinesFailing", 0).coerceAtLeast(0) else 0
        val routinesLate = if (version >= 3) o.optInt("routinesLate", 0).coerceAtLeast(0) else 0
        val redact = o.optBoolean("redact", false)
        val configBots = when {
          redact -> emptyList()
          o.has("configBots") -> parseBots(o.optJSONArray("configBots"), Int.MAX_VALUE)
          else -> bots
        }
        Parsed.Ok(
          WidgetPayload(status, o.getBoolean("connected"), work, result, approvals, writtenAt, runs, bots, routinesFailing, routinesLate, redact, configBots),
        )
      } catch (_: Exception) {
        Parsed.Invalid
      }
    }

    /** Up to three named runs; a nameless row is skipped rather than drawn blank. */
    private fun parseRuns(array: JSONArray?): List<WidgetRun> {
      if (array == null) return emptyList()
      val runs = ArrayList<WidgetRun>(3)
      for (i in 0 until array.length()) {
        if (runs.size == 3) break
        val item = array.optJSONObject(i) ?: continue
        val title = item.optString("title", "").trim()
        val state = item.optString("state", "").trim()
        if (title.isBlank() || state.isBlank()) continue
        runs.add(WidgetRun(title, state))
      }
      return runs
    }

    /** Card rows default to three; configuration reads the complete Roster. */
    private fun parseBots(array: JSONArray?, limit: Int = 3): List<WidgetBot> {
      if (array == null) return emptyList()
      val bots = ArrayList<WidgetBot>(3)
      for (i in 0 until array.length()) {
        if (bots.size == limit) break
        val item = array.optJSONObject(i) ?: continue
        val id = item.optString("id", "").trim()
        val label = item.optString("label", "").trim()
        if (id.isBlank() || label.isBlank()) continue
        bots.add(WidgetBot(id, label))
      }
      return bots
    }
  }
}
