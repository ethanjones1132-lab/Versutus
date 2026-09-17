package com.versutus.widget

/** The per-instance state a placed widget keeps: which Bot it is pinned to. Pure, JVM-tested. */
object WidgetConfigState {
  const val BOT_KEY = "configured_bot_id"

  fun read(pinned: String?): String? = pinned?.trim()?.takeIf { it.isNotEmpty() }
  fun write(botId: String): String = botId.trim()

  data class Selection(val bots: List<WidgetBot>, val unavailable: Boolean)

  fun selection(pinned: String?, bots: List<WidgetBot>, configBots: List<WidgetBot> = bots): Selection {
    if (pinned == null) return Selection(bots, false)
    val matches = configBots.filter { it.id == pinned }
    return Selection(matches, matches.isEmpty())
  }
}
