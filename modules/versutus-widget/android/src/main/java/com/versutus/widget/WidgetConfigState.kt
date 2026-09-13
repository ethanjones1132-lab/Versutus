package com.versutus.widget

/** The per-instance state a placed widget keeps: which Bot it is pinned to. Pure, JVM-tested. */
object WidgetConfigState {
  const val BOT_KEY = "configured_bot_id"

  fun read(pinned: String?): String? = pinned?.trim()?.takeIf { it.isNotEmpty() }
  fun write(botId: String): String = botId.trim()
}
