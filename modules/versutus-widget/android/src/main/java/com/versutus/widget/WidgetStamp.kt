package com.versutus.widget

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.time.temporal.ChronoUnit
import java.util.Locale

/** "Written <day> <time>", the same words the app's widget-target fold uses. */
object WidgetStamp {
  private const val UNREADABLE = "Written at an unreadable time"

  fun line(writtenAt: Long, now: Long, zone: ZoneId, locale: Locale): String {
    if (writtenAt <= 0) return UNREADABLE
    val written = Instant.ofEpochMilli(writtenAt).atZone(zone)
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    val days = ChronoUnit.DAYS.between(written.toLocalDate(), today)
    val day = when {
      days <= 0 -> "Today"
      days == 1L -> "Yesterday"
      days < 7 -> written.dayOfWeek.getDisplayName(TextStyle.FULL, locale)
      written.year != Instant.ofEpochMilli(now).atZone(zone).year ->
        written.format(DateTimeFormatter.ofPattern("d MMM yyyy", locale))
      else -> written.format(DateTimeFormatter.ofPattern("d MMM", locale))
    }
    val time = written.format(DateTimeFormatter.ofPattern("HH:mm", locale))
    return "Written $day $time"
  }
}
