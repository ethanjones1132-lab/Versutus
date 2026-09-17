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

  /**
   * A snapshot this much older than "now" reads as frozen. The stated age is
   * twice the WidgetRefreshWorker's own 6-hour redraw interval: a card the app
   * has not written across two redraws cannot honestly claim to be current.
   */
  private const val STALE_MS = 2 * 6L * 60 * 60 * 1000

  /** True only when the stamp is readable and older than the stated age. */
  fun isStale(writtenAt: Long, now: Long): Boolean =
    writtenAt > 0 && writtenAt <= now && (now - writtenAt) >= STALE_MS

  fun line(writtenAt: Long, now: Long, zone: ZoneId, locale: Locale): String {
    if (writtenAt <= 0 || writtenAt > now) return UNREADABLE
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
